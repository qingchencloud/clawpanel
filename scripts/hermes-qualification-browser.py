#!/usr/bin/env python3
"""Hermes 实际浏览器长验收；保留原 Send8，不安装 runtime，不重试抹红灯。"""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sys
import subprocess
import shlex
import selectors
import signal
import stat
import tarfile
from xml.sax.saxutils import escape
import time
import traceback
from urllib.parse import urlsplit, unquote
import uuid

if not __debug__:
    raise RuntimeError('qualification requires assertions; remove -O/PYTHONOPTIMIZE')

ORIGINAL_SOURCES = {
    'bootstrap': '45209e4fbd161555c0bac5c47d5cb62bd8a655280baf634faf2f728fb542ee97',
    'browser': '3a46991eb5bcd6a365624ab78488943097cabfa4a2ee66d9ccc9e6a4ec81eaa2',
}
NONCE = re.compile(r'browser-acceptance-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')


def validate_metadata_receipt(receipt):
    assert receipt.get('accepted') is True
    method, path, body = receipt.get('method'), receipt.get('path'), receipt.get('body')
    assert type(body) is dict
    if method == 'GET' and path in ('/v1/models', '/api/v1/models', '/api/tags', '/v1/props', '/props', '/version', '/v1/models/maintenance-model'):
        assert body == {}
        assert receipt.get('responseStatus') == (200 if path == '/v1/models' else 404)
        protocols = {'/v1/models': 'openai-catalog', '/api/v1/models': 'lm-studio', '/api/tags': 'ollama', '/v1/props': 'llamacpp', '/props': 'llamacpp', '/version': 'vllm', '/v1/models/maintenance-model': 'openai'}
        assert receipt.get('provider') == protocols[path]
    elif method == 'POST' and path == '/api/show':
        assert body == {'name': 'maintenance-model'}
        assert receipt.get('responseStatus') == 404
        assert receipt.get('provider') == 'ollama'
    else:
        raise AssertionError('未经归因的 metadata 路径/方法')


def validate_base_url(value):
    u = urlsplit(value)
    if (u.scheme != 'http' or u.hostname not in ('127.0.0.1', 'localhost', '::1')
            or u.username is not None or u.password is not None or u.query
            or u.fragment or u.path not in ('', '/') or not u.port):
        raise ValueError('--base-url 必须是无凭据/参数的回环 HTTP 发布端口')
    return value.rstrip('/')


# 私有测试字体证据：不安装系统包，不修改CSS/DOM，不把cmap声明代替实际渲染。
def parse_fc_charset(value):
    assert isinstance(value, str) and value.strip(), 'fontconfig charset缺失'
    rows, end = [], -1
    for word in value.split():
        assert re.fullmatch(r'[0-9a-fA-F]+(?:-[0-9a-fA-F]+)?', word), 'fontconfig charset格式'
        parts = word.split('-'); first = int(parts[0], 16); last = int(parts[-1], 16)
        assert end < first <= last <= 0x10ffff, 'fontconfig charset范围/次序'
        rows.append((first, last)); end = last
    return rows


FONT_NAMES = {'NotoSansCJK-Bold.ttc', 'NotoSansCJK-Regular.ttc', 'NotoSerifCJK-Bold.ttc', 'NotoSerifCJK-Regular.ttc'}
APT_FONT_FLAGS = ['-o', 'Acquire::AllowInsecureRepositories=false', '-o', 'Acquire::AllowWeakRepositories=false',
                  '-o', 'APT::Get::AllowUnauthenticated=false', '-o', 'Acquire::ForceHash=SHA256']


def font_command(args, *, cwd=None, env=None, timeout=15):
    try:
        result = subprocess.run(args, cwd=cwd, env={**(os.environ if env is None else env), 'LC_ALL': 'C.UTF-8'}, capture_output=True, text=True, encoding='utf-8', timeout=timeout, check=False)
        assert len(result.stdout.encode('utf-8')) <= 4 * 1024 * 1024, '字体metadata输出超限'
        return {'args': args, 'exitCode': result.returncode, 'stdout': result.stdout, 'error': redact(result.stderr)}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'args': args, 'exitCode': 127, 'stdout': '', 'error': redact(error)}


def deb822(text):
    rows, row, key = [], {}, None
    for line in [*text.splitlines(), '']:
        if not line:
            if row: rows.append(row)
            row, key = {}, None
        elif line[0].isspace():
            assert key, 'apt字段续行缺键'
            row[key] += '\n' + line.strip()
        else:
            key, sep, value = line.partition(':')
            assert sep and key not in row, 'apt字段缺失/重复'
            row[key] = value.strip()
    return rows


# 固定GHA配置来源Git blob b3f5b2b180df8eb39fcbba034f616e03a69e775c；不接收调用方路径。
def parse_official_font_mirrors(text):
    assert isinstance(text, str) and 0 < len(text.encode('utf-8')) <= 4096 and '\0' not in text, 'mirror列表大小/格式'
    allowed = {'http://azure.archive.ubuntu.com/ubuntu/': 'priority:1',
               'https://archive.ubuntu.com/ubuntu/': 'priority:2',
               'https://security.ubuntu.com/ubuntu/': 'priority:3'}
    mirrors, seen = [], set()
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        words = line.split(); assert len(words) in (1, 2), '未知mirror元数据'
        url = words[0]; assert url in allowed and url not in seen, '非固定官方mirror/重复端点'
        assert len(words) == 1 or words[1] == allowed[url], '未知mirror优先级'
        seen.add(url); mirrors.append({'url': url, 'priority': words[1] if len(words) == 2 else None})
    assert mirrors, 'mirror列表为空'
    return mirrors


def check_fixed_mirror_stat(info):
    assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'mirror文件类型/所有权/写权限'
    assert info.st_nlink == 1 and 0 < info.st_size <= 4096, 'mirror文件链接/大小'


def read_fixed_apt_mirror():
    file = Path('/etc/apt/apt-mirrors.txt')
    assert not file.is_symlink() and file.resolve(strict=True) == file, '固定mirror路径为链接'
    for parent in file.parents:
        info = parent.lstat()
        assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'mirror父目录不受信'
    identity = lambda i: [i.st_dev, i.st_ino, i.st_uid, i.st_mode, i.st_nlink, i.st_size, i.st_mtime_ns]
    with os.fdopen(os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC), 'rb') as stream:
        before = os.fstat(stream.fileno()); check_fixed_mirror_stat(before)
        raw = stream.read(4097); after = os.fstat(stream.fileno()); check_fixed_mirror_stat(after)
        assert identity(before) == identity(after) == identity(file.lstat()) and len(raw) == before.st_size, 'mirror读取期间漂移'
    text = raw.decode('utf-8')
    return {'path': str(file), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
            'identity': identity(before), 'content': text, 'mirrors': parse_official_font_mirrors(text)}


def validate_font_download(metadata, indexes, uris, version):
    records = deb822(metadata)
    assert len(records) == 1, '字体包索引非唯一'
    record = records[0]
    assert record['Package'] == record.get('Source', 'fonts-noto-cjk').split(' ')[0] == 'fonts-noto-cjk'
    assert record['Architecture'] == 'all' and record['Version'] == version and re.fullmatch(r'[0-9][a-zA-Z0-9.+:~_-]*', version)
    size, unpacked = int(record['Size']), int(record['Installed-Size']) * 1024
    assert 0 < size <= 128 * 1024 * 1024 and 0 < unpacked <= 512 * 1024 * 1024, '字体包大小未知/超限'
    assert re.fullmatch('[a-f0-9]{64}', record['SHA256']), '字体包缺SHA256'
    name = record['Filename']; parts = PurePosixPath(name).parts
    assert name.startswith('pool/main/f/fonts-noto-cjk/') and '..' not in parts and name.endswith('_all.deb') and '\\' not in name
    lines = uris.strip().splitlines(); assert len(lines) == 1, '字体下载URI非唯一'
    uri, archive, stated_size, stated_hash = shlex.split(lines[0])
    url = urlsplit(uri)
    assert not (url.username or url.password or url.query or url.fragment)
    mirror_source = None
    if url.scheme == 'mirror+file':
        assert not url.netloc and unquote(url.path) == '/etc/apt/apt-mirrors.txt/' + unquote(name), '非固定mirror wrapper路径'
        assert record.get('Origin') == 'Ubuntu', 'mirror包缺Ubuntu来源'
        mirror_source = read_fixed_apt_mirror()
    else:
        assert url.scheme in ('https', 'http')
        assert url.hostname in ('archive.ubuntu.com', 'azure.archive.ubuntu.com', 'security.ubuntu.com', 'ports.ubuntu.com') or re.fullmatch(r'[a-z]{2}\.archive\.ubuntu\.com', url.hostname or '')
    assert unquote(url.path).endswith('/' + unquote(name)) and int(stated_size) == size and stated_hash == 'SHA256:' + record['SHA256']
    assert re.fullmatch(r'fonts-noto-cjk_[a-zA-Z0-9+_.:%~-]+_all\.deb', archive), '字体下载文件名'
    trusted = [i for i in deb822(indexes) if i.get('Identifier') == 'Packages' and i.get('Origin') == i.get('Label') == 'Ubuntu'
               and i.get('Trusted') == 'yes' and uri.startswith(i.get('Site', '').rstrip('/') + '/') and i.get('Site')]
    if mirror_source:
        trusted = [i for i in trusted if i['Site'] == 'mirror+file:/etc/apt/apt-mirrors.txt' and i.get('Component') == 'main'
                   and re.fullmatch(r'/etc/apt/sources\.list\.d/ubuntu\.sources:[1-9][0-9]*', i.get('Sourcesentry', ''))]
    assert trusted, '没有相应已签名Ubuntu索引'
    return {'version': version, 'sha256': record['SHA256'], 'bytes': size, 'unpackedLimit': unpacked,
            'sourceURL': uri, 'archiveName': archive, 'metadata': record, 'indexes': trusted,
            **({'mirrorSource': mirror_source} if mirror_source else {})}


def fingerprint_font_file(file, directory='/usr/share/fonts'):
    file, directory = Path(file), Path(directory)
    assert file.is_absolute() and file.is_file() and not any(p.is_symlink() for p in [file, *file.parents]), '字体文件类型/路径'
    assert file.resolve().is_relative_to(directory.resolve()) and file.resolve() == file, '字体不在限定目录/路径链接'
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''): h.update(chunk)
    return {'file': str(file), 'sha256': h.hexdigest(), 'bytes': file.stat().st_size}


# 仅从已校验deb的data tar提取四个普通字体，不执行control/postinst或导入包的系统配置。
def extract_private_font_tar(stream, destination, unpacked_limit):
    assert type(unpacked_limit) is int and 0 < unpacked_limit <= 512 * 1024 * 1024
    destination = Path(destination); assert not destination.exists()
    destination.mkdir(mode=0o700)
    class BoundedTar:
        remaining = unpacked_limit + 4096 * 1024
        def read(self, size=-1):
            assert size >= 0, 'tar无界读取'
            data = stream.read(min(size, self.remaining + 1)); self.remaining -= len(data)
            assert self.remaining >= 0, 'tar流总量超限'
            return data
    bounded = BoundedTar(); members, fonts, seen, total = [], [], set(), 0
    with tarfile.open(fileobj=bounded, mode='r|') as archive:
        for member in archive:
            original = member.name
            name = original[2:] if original.startswith('./') else original
            if name in ('', '.') and member.isdir(): continue
            path = PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in name and name not in seen and len(seen) < 4096, 'tar路径逃逸/重复/超额'
            seen.add(name); item = {'name': name, 'type': member.type.decode('ascii'), 'bytes': member.size, 'extracted': False}
            assert member.isdir() or member.isfile() or member.issym(), 'tar特殊文件/硬链接'
            is_font = name.startswith('usr/share/fonts/')
            if is_font and not member.isdir():
                assert member.isfile() and name == 'usr/share/fonts/opentype/noto/' + path.name and path.name in FONT_NAMES, '字体成员不是受管普通文件'
            if member.isfile():
                total += member.size; assert member.size >= 0 and total <= unpacked_limit, 'tar解压量超限'
                source = archive.extractfile(member); h = hashlib.sha256(); count = 0
                target = (destination / path.name).open('xb') if is_font else None
                try:
                    for chunk in iter(lambda: source.read(65536), b''):
                        count += len(chunk); assert count <= member.size
                        h.update(chunk)
                        if target: target.write(chunk)
                finally:
                    if target: target.close()
                assert count == member.size, 'tar成员不完整'
                item['sha256'] = h.hexdigest()
                if is_font:
                    item['extracted'] = True
                    fonts.append({'file': str(destination / path.name), 'bytes': count, 'sha256': h.hexdigest(), 'archiveMember': name})
            if member.issym(): item['ignoredLinkTarget'] = member.linkname
            members.append(item)
    while bounded.read(65536): pass
    assert {Path(f['file']).name for f in fonts} == FONT_NAMES, '字体成员缺失'
    return {'members': members, 'fonts': fonts, 'unpackedBytes': total}


def extract_private_font_process(deb, destination, unpacked_limit):
    # 原15秒覆盖启动、首字节/中途读取、wait与清理；预留250ms用于本组kill/reap。
    deadline = time.monotonic() + 15
    read_deadline = deadline - 0.25
    child = subprocess.Popen(['dpkg-deb', '--fsys-tarfile', str(deb)], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, start_new_session=True)
    def remaining():
        value = read_deadline - time.monotonic()
        if value <= 0: raise TimeoutError('deb data读取/等待超过15秒总期限')
        return value
    try:
        fd = child.stdout.fileno(); os.set_blocking(fd, False)
        with selectors.DefaultSelector() as ready:
            ready.register(fd, selectors.EVENT_READ)
            class DeadlinePipe:
                def read(self, size=-1):
                    assert size >= 0, 'deb data无界读取'
                    if size == 0: return b''
                    while True:
                        if not ready.select(remaining()): raise TimeoutError('deb data读取超过15秒总期限')
                        try: data = os.read(fd, min(size, 65536))
                        except BlockingIOError: continue
                        remaining()
                        return data
            extracted = extract_private_font_tar(DeadlinePipe(), destination, unpacked_limit)
            assert child.wait(timeout=remaining()) == 0, 'deb data解包失败'
            return extracted
    except subprocess.TimeoutExpired as error:
        raise TimeoutError('deb data等待超过15秒总期限') from error
    finally:
        # 即使leader已退出也清理本次setsid进程组，禁止等持管道的后代自行退出。
        child.stdout.close()
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try: child.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as error:
            raise TimeoutError('deb data自有进程回收未在15秒总期限内完成') from error
        if time.monotonic() > deadline: raise TimeoutError('deb data超过15秒总期限')


def verify_private_fonts(proof):
    root = Path(proof['root'])
    assert root.is_absolute() and root.resolve() == root and not any(p.is_symlink() for p in [root, *root.parents])
    assert Path(proof['config']) == root / 'fonts.conf' and Path(proof['archive']).parent == root / 'download', '私有字体证据目录'
    config = fingerprint_font_file(proof['config'], root); archive = fingerprint_font_file(proof['archive'], root)
    assert config['sha256'] == proof['configSha256'] and archive['sha256'] == proof['archiveSha256'] and archive['bytes'] == proof['archiveBytes'] > 0, '字体配置/归档漂移'
    assert len(proof['fonts']) == 4 and {Path(f['file']).name for f in proof['fonts']} == FONT_NAMES
    for font in proof['fonts']:
        assert Path(font['file']).parent == root / 'fonts'
        actual = fingerprint_font_file(font['file'], root / 'fonts')
        assert actual['sha256'] == font['sha256'] and actual['bytes'] == font['bytes'], '私有字体成员漂移'
    assert (root / 'cache').is_dir() and not (root / 'cache').is_symlink()


def private_font_environment(proof, parent=None):
    verify_private_fonts(proof)
    root = Path(proof['root'])
    child = {**(os.environ if parent is None else parent), 'FONTCONFIG_FILE': str(root / 'fonts.conf'),
             'FONTCONFIG_PATH': str(root), 'XDG_CACHE_HOME': str(root / 'cache')}
    child.pop('FONTCONFIG_SYSROOT', None)
    return child


def font_environment(phase, private=None):
    assert phase in ('before', 'after')
    assert phase != 'after' or private, 'after必须为私有字体环境'
    env = private_font_environment(private) if private else None
    commands = {'packages': font_command(['dpkg-query', '-W', '-f', '${Package}\t${Version}\n', 'fontconfig']),
                'origin': font_command(['apt-cache', 'policy', 'fonts-noto-cjk']),
                'fontconfig': font_command(['fc-list', ':lang=zh-cn', '--format', '%{file}\t%{index}\t%{family}\n'], env=env)}
    result = {'schemaVersion': 2, 'scope': 'private-fontconfig-environment-not-product-fix', 'phase': phase,
              'platform': sys.platform, 'capturedAt': utc(), 'commands': commands, 'faces': [],
              'osRelease': Path('/etc/os-release').read_text() if Path('/etc/os-release').is_file() else ''}
    if phase == 'after':
        assert sys.platform == 'linux' and all(c['exitCode'] == 0 for c in commands.values()), '既有fontconfig工具未就绪'
        result['packages'] = dict(row.split('\t', 1) for row in commands['packages']['stdout'].splitlines())
        assert result['packages'].get('fontconfig'), '既有fontconfig版本缺失'
        result['packages']['fonts-noto-cjk'] = private['package']['version']; result['private'] = private
        for font in private['fonts']:
            query = font_command(['fc-query', '--format', '%{index}\t%{family}\t%{postscriptname}\t%{charset}\n', font['file']], env=env)
            assert query['exitCode'] == 0, 'fc-query实际字体失败'
            for line in query['stdout'].splitlines():
                index, family, postscript, charset = line.split('\t', 3)
                assert index.isdigit() and family and postscript; parse_fc_charset(charset)
                result['faces'].append({**font, 'index': int(index), 'family': family, 'postscriptName': postscript, 'charset': charset})
        assert result['faces'], '未发现实际私有Noto字体face'
    return result


def prepare_private_fonts(evidence, private_root):
    assert sys.platform == 'linux' and os.geteuid() != 0, '字体准备仅非root Linux job'
    out, root = Path(evidence).resolve(), Path(private_root).absolute()
    assert out.is_dir() and out.parent == root.parent and not root.exists() and root.resolve() == root
    started = time.monotonic()
    (out / 'fontconfig-before.json').write_text(json.dumps(font_environment('before'), ensure_ascii=False, indent=2))
    root.mkdir(mode=0o700); download = root / 'download'; download.mkdir(); (root / 'cache').mkdir()
    receipts, package = {}, None
    def command(label, args, **kwargs):
        value = font_command(args, **kwargs); receipts[label] = value
        (out / 'font-package.json').write_text(json.dumps({'status': 'preparing', 'commands': receipts, **({'package': package} if package else {})}, ensure_ascii=False, indent=2))
        assert value['exitCode'] == 0, '字体准备失败: ' + label
        return value['stdout']
    policy = command('policy', ['apt-cache', 'policy', 'fonts-noto-cjk'])
    candidate = re.search(r'^\s*Candidate: (\S+)$', policy, re.M); assert candidate and candidate[1] != '(none)', '字体候选缺失'
    spec = 'fonts-noto-cjk=' + candidate[1]
    metadata = command('metadata', ['apt-cache', 'show', '--no-all-versions', spec])
    indexes = command('indexes', ['apt-get', 'indextargets'])
    uris = command('uris', ['apt-get', *APT_FONT_FLAGS, '--print-uris', 'download', spec], cwd=download)
    package = validate_font_download(metadata, indexes, uris, candidate[1])
    command('download', ['apt-get', *APT_FONT_FLAGS, 'download', spec], cwd=download, timeout=120)
    if 'mirrorSource' in package:
        after_mirror = read_fixed_apt_mirror()
        assert after_mirror == package['mirrorSource'], '下载期间固定mirror文件漂移'
        package['mirrorSourceAfter'] = after_mirror
    deb = download / package['archiveName']; assert list(download.iterdir()) == [deb], '字体下载出现额外文件'
    actual = fingerprint_font_file(deb, download)
    assert actual['sha256'] == package['sha256'] and actual['bytes'] == package['bytes'], '字体归档SHA/大小漂移'
    control = deb822(command('control', ['dpkg-deb', '--field', str(deb)]))
    assert len(control) == 1 and all(control[0].get(k) == package['metadata'][k] for k in ('Package', 'Version', 'Architecture', 'Installed-Size')), 'deb实际control与索引不同'
    # dpkg-deb只向pipe解包data，不安装、不执行maintainer scripts。
    extracted = extract_private_font_process(deb, root / 'fonts', package['unpackedLimit'])
    config = root / 'fonts.conf'
    config.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>'
                      '<dir>' + escape(str(root / 'fonts')) + '</dir><cachedir>' + escape(str(root / 'cache')) + '</cachedir>'
                      '<alias><family>sans-serif</family><prefer><family>Noto Sans CJK SC</family></prefer></alias>'
                      '<alias><family>serif</family><prefer><family>Noto Serif CJK SC</family></prefer></alias>'
                      '<alias><family>monospace</family><prefer><family>Noto Sans Mono CJK SC</family></prefer></alias></fontconfig>', encoding='utf-8')
    proof = {'root': str(root), 'config': str(config), 'configSha256': hashlib.sha256(config.read_bytes()).hexdigest(),
             'archive': str(deb), 'archiveSha256': actual['sha256'], 'archiveBytes': actual['bytes'], **extracted, 'package': package}
    command('private-cache', ['fc-cache', '--force', str(root / 'fonts')], env=private_font_environment(proof))
    (out / 'font-package.json').write_text(json.dumps({'proof': proof, 'commands': receipts}, ensure_ascii=False, indent=2))
    (out / 'fontconfig-after.json').write_text(json.dumps(font_environment('after', proof), ensure_ascii=False, indent=2))
    (out / 'font-setup-timing.json').write_text(json.dumps({'elapsedSeconds': time.monotonic()-started, 'scope': 'non-root private font setup outside210s; visual root cause unproven'}))


def read_font_environment(directory):
    root = Path(directory).absolute(); assert not root.is_symlink()
    snapshots, hashes = {}, {}
    for phase in ('before', 'after'):
        file = root / ('fontconfig-' + phase + '.json')
        assert file.is_file() and not any(p.is_symlink() for p in [file, *file.parents]), '字体环境收据路径'
        raw = file.read_bytes(); snapshots[phase] = json.loads(raw); hashes[phase + 'Sha256'] = hashlib.sha256(raw).hexdigest()
        assert snapshots[phase]['phase'] == phase and snapshots[phase]['schemaVersion'] == 2
    after = snapshots['after']
    assert after['platform'] == 'linux' and after['faces'] and all(c['exitCode'] == 0 for c in after['commands'].values())
    assert all(after['packages'].get(name) for name in ('fontconfig', 'fonts-noto-cjk'))
    env = private_font_environment(after['private']); known = {f['file']: f for f in after['private']['fonts']}
    for face in after['faces']:
        parse_fc_charset(face['charset']); font = known[face['file']]
        assert face['sha256'] == font['sha256'] and face['bytes'] == font['bytes'], '字体face不是实际归档成员'
    return {**hashes, 'faces': after['faces'], 'childEnv': env, 'rootCause': 'private font remediation pending real screenshot review; not established by cmap alone'}


def assert_cjk_coverage(text, platform_fonts, faces):
    points = sorted({ord(c) for c in text if 0x3400 <= ord(c) <= 0x9fff or 0x20000 <= ord(c) <= 0x323af})
    assert points, '真实回复缺中文样本'
    assert isinstance(platform_fonts, list) and platform_fonts, '缺实际CDP字体'
    used = [f for f in platform_fonts if type(f.get('glyphCount')) in (int, float)
            and math.isfinite(f['glyphCount']) and f['glyphCount'] > 0 and f['glyphCount'] == int(f['glyphCount'])
            and f.get('isCustomFont') is False]
    matched = [f for f in faces if any(p.get('postScriptName') == f['postscriptName'] for p in used)]
    ranges = [r for f in matched for r in parse_fc_charset(f['charset'])]
    missing = [format(c, 'x') for c in points if not any(a <= c <= b for a, b in ranges)]
    assert matched and not missing, '实际渲染字体缺中文glyph覆盖: ' + ','.join(missing)
    assert all(re.fullmatch('[a-f0-9]{64}', f['sha256']) for f in matched), '实际字体文件hash缺失'
    return {'textSha256': hashlib.sha256(text.encode()).hexdigest(), 'codepoints': [format(c, 'x') for c in points],
            'missingCodepoints': missing, 'platformFonts': platform_fonts, 'matchedFaces': matched}


def capture_cjk_sample(page, locator, text, label, screenshot, faces):
    actual = locator.evaluate("""e => { const parts=[]; for(let n=e;n;n=n.parentElement){const p=n.parentElement;parts.unshift(n.localName+(p?':nth-child('+(Array.from(p.children).indexOf(n)+1)+')':''))} const r=e.getBoundingClientRect();return {text:e.innerText,selector:parts.join(' > '),visible:r.width>0&&r.height>0,fontFamily:getComputedStyle(e).fontFamily} }""")
    assert actual['text'] == text and actual['visible'], '不是实际可见完整中文回复'
    session = page.context.new_cdp_session(page)
    try:
        session.send('DOM.enable'); session.send('CSS.enable')
        doc = session.send('DOM.getDocument', {'depth': 0})
        node = session.send('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': actual['selector']})
        assert node['nodeId'] > 0, '实际回复DOM节点缺失'
        fonts = session.send('CSS.getPlatformFontsForNode', {'nodeId': node['nodeId']})['fonts']
        proof = assert_cjk_coverage(text, fonts, faces)
    finally:
        session.detach()
    screenshot = Path(screenshot)
    assert screenshot.is_file() and not screenshot.is_symlink(), '实际截图PNG缺失'
    raw = screenshot.read_bytes(); assert raw[:8] == bytes.fromhex('89504e470d0a1a0a'), '实际截图PNG缺失'
    return {**proof, 'label': label, 'selector': actual['selector'], 'computedFontFamily': actual['fontFamily'],
            'screenshot': Path(screenshot).name, 'screenshotSha256': hashlib.sha256(raw).hexdigest()}


def validate_cjk_report(proof, texts=None):
    assert proof['required'] is True and len(proof['samples']) == 2
    assert [s['label'] for s in proof['samples']] == ['reply', 'restarted']
    for key in ('beforeSha256', 'afterSha256'):
        assert re.fullmatch('[a-f0-9]{64}', proof['environment'][key]), '字体环境hash缺失'
    for i, sample in enumerate(proof['samples']):
        assert sample['missingCodepoints'] == [] and re.fullmatch('[a-f0-9]{64}', sample['screenshotSha256'])
        text = texts[i] if texts else ''.join(chr(int(c, 16)) for c in sample['codepoints'])
        recomputed = assert_cjk_coverage(text, sample['platformFonts'], proof['environment']['faces'])
        assert sample['codepoints'] == recomputed['codepoints']
        if texts:
            assert sample['textSha256'] == recomputed['textSha256'], '字体证明未绑定本轮回复'


def parse_options(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-url', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--hold', type=int, default=210)
    p.add_argument('--font-environment', help='host准备的fontconfig before/after证据目录；不预建本轮output')
    a = p.parse_args(argv)
    try:
        a.base_url = validate_base_url(a.base_url)
    except ValueError as error:
        p.error(str(error))
    if not 210 <= a.hold <= 3600:
        p.error('--hold 必须在 210..3600 秒；210 秒必须实际取得 42 个 5 秒样本')
    return a


def expected_steps(hold):
    return ['actual-ui-start-health-and-online-class',
            'actual-ui-send-and-full-reply', 'reload-restores-real-history',
            f'sustained-gateway-health-{hold}s', 'managed-stop-actually-offline',
            'restart-preserves-history', 'post-restart-actual-reply',
            'final-stop-offline-data-retained']


def full_reply(nonce):
    return f'浏览器完整回复：{nonce}；模型：maintenance-model。'


def check_health(h, version):
    assert isinstance(h, dict) and h.get('status') == 'ok', '实际 health 未成功'
    assert h.get('platform') == 'hermes-agent', '不是 Hermes health'
    assert h.get('version') == version, '真实 health 版本漂移'


def check_online(s, baseline=None):
    assert s.get('gatewayRunning') is True and s.get('portOpen') is True
    assert s.get('ownershipVerified') is True, '没有实际 /proc ownership'
    pids, identities = s.get('gatewayPids'), s.get('gatewayIdentity')
    assert pids and all(type(p) is int and p > 0 for p in pids), 'PID 非法'
    assert len(set(pids)) == len(pids)
    assert isinstance(identities, list) and [i['pid'] for i in identities] == pids
    assert all(re.fullmatch(r'\d+', i.get('startTicks', '')) for i in identities)
    assert type(s.get('gatewayPort')) is int and 0 < s['gatewayPort'] < 65536
    assert re.fullmatch(r'[a-f0-9]{40}', s.get('sourceSha', ''))
    assert re.fullmatch(r'\d+\.\d+\.\d+', s.get('version', ''))
    assert s.get('home', '').startswith('/')
    for key in ('source', 'environment', 'freshEvidence'):
        assert re.fullmatch(r'[a-f0-9]{64}', s.get('fingerprints', {}).get(key, '')), key
    if baseline is not None:
        for key in ('sourceSha', 'version', 'home', 'gatewayPort', 'fingerprints'):
            assert s[key] == baseline[key], f'{key} 漂移'


def check_offline(s, baseline):
    assert s.get('gatewayRunning') is False and s.get('portOpen') is False
    assert s.get('gatewayPids') == [] and s.get('gatewayIdentity') == []
    assert s.get('pidsExited') is True and s.get('lastAction') == 'stop'
    assert s.get('ownershipVerified') is True
    for key in ('sourceSha', 'version', 'home', 'gatewayPort', 'fingerprints'):
        assert s.get(key) == baseline[key], f'stop 后 {key} 漂移'


def validate_report(r):
    """严格的可离线重验契约；合成测试报告永远不是 live 验收证据。"""
    assert r.get('ok') is True and r.get('errors') == [], '未通过/存在 pageerror'
    hold = r['hold']['seconds']
    assert type(hold) is int and 210 <= hold <= 3600
    assert r['steps'] == expected_steps(hold), '原8断言未全部完成'
    b = r['baseline']
    check_online(b)
    samples = r['hold']['health']
    assert len(samples) == math.ceil(hold / 5), '严格样本数不符（210 秒必须42次）'
    elapsed = r['hold']['elapsedSeconds']
    assert isinstance(elapsed, (float, int)) and math.isfinite(elapsed) and elapsed >= hold
    for index, s in enumerate(samples):
        assert s['index'] == index and s['status'] == 200
        # 真实单调时钟；不补采/不压缩延迟。每个5秒窗口最多一个样本。
        assert index * 5 <= s['offsetSeconds'] < (index + 1) * 5, '错过/伪造采样窗口'
        assert s['offsetSeconds'] <= elapsed
        check_health(s['health'], b['version'])
        check_online(s['snapshot'], b)
        assert s['snapshot']['gatewayIdentity'] == b['gatewayIdentity'], 'hold 中 Gateway 重启'
        assert s['snapshot']['gatewayPids'] == b['gatewayPids']
    life = r['lifecycle']
    check_online(life['initialOnline'], b)
    assert life['initialOnline']['gatewayIdentity'] == b['gatewayIdentity']
    check_offline(life['afterStop'], b)
    check_online(life['restarted'], b)
    assert life['restarted']['gatewayIdentity'] != b['gatewayIdentity'], 'restart 未产生新进程身份'
    check_offline(life['finalStop'], b)
    for k in ('historyAfterReload', 'historyAfterRestart', 'finalDataRetained'):
        assert life.get(k) is True, k
    assert len(r['sends']) == 2
    nonces = []
    for send in r['sends']:
        n = send['nonce']
        assert NONCE.fullmatch(n) and n not in nonces
        nonces.append(n)
        assert send['method'] == 'button.click', '必须实际 Send 按钮'
        assert send['reply'] == full_reply(n) and send['fullReplyVisible'] is True
    if r.get('cjk', {}).get('required'):
        validate_cjk_report(r['cjk'], [send['reply'] for send in r['sends']])
    provider = r['provider']
    assert type(provider['afterSequence']) is int and provider['afterSequence'] >= 0
    receipts = provider['receipts']
    assert 2 <= len(receipts) <= 130, '本轮只允许2次聊天和有界只读 metadata 请求'
    chats = []
    for i, c in enumerate(receipts):
        assert c['seq'] == provider['afterSequence'] + i + 1, 'Provider 序号漏项/重项'
        if c.get('kind') == 'metadata':
            validate_metadata_receipt(c)
            continue
        assert c.get('kind') in (None, 'chat'), '未知 Provider 请求种类'
        chats.append(c)
        assert c.get('nonceOccurrences') == 1 and c.get('accepted') is True and c.get('authMatches') is True
        assert c.get('model') == 'maintenance-model' and c.get('path') == '/v1/chat/completions'
    assert len(chats) == 2, '本轮 Provider 聊天请求必须恰好2次'
    assert [c['nonce'] for c in chats] == nonces


def validate_ready(ready):
    assert ready['schemaVersion'] == 1 and ready['status'] == 'ready'
    assert ready['browserReady'] is True and ready['mode'] == 'warm-after-original-fresh11'
    assert ready['originalSources'] == ORIGINAL_SOURCES
    for key in ('requestedByParent', 'linux', 'dockerMarker', 'nonRoot', 'noNewPrivileges', 'noCapabilities', 'noDockerSocket'):
        assert ready['nonPrivilegedProof'].get(key) is True, key
    assert type(ready['webPid']) is int and ready['webPid'] > 0
    assert ready['initial']['sourceSha'] == ready['sourceSha']
    assert ready['initial']['version'] == ready['version'] == ready['target']['version']
    assert ready['initial']['home'] == ready['home']
    assert ready['ports']['gateway'] == ready['initial']['gatewayPort']
    assert ready['freshReportSha256'] == ready['initial']['fingerprints']['freshEvidence']
    check_online(ready['initial'])


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def redact(value):
    text = str(value)
    text = re.sub(r'\b(?:sk|ghp|gho)-[\w-]{8,}', '[REDACTED]', text)
    return re.sub(r'(?i)((?:authorization|api[_-]?key|password|token|cookie)[\"\x27]?\s*[:=]\s*)[^\s,}\n]+', r'\1[REDACTED]', text)


def fresh_output(value):
    out = Path(value).absolute()
    assert not out.exists(), 'output 必须全新，两轮不得覆盖'
    for p in [out, *out.parents]:
        assert not p.is_symlink(), 'output 祖先不得是符号链接'
    out.mkdir(parents=True, mode=0o700)
    return out


def run(a):
    out = fresh_output(a.output)
    r = {'schemaVersion': 1, 'ok': False, 'scope': 'real-hermes-warm-browser-ui-local-provider',
         'startedAt': utc(), 'baseUrl': a.base_url, 'steps': [], 'errors': [],
         'originalSources': ORIGINAL_SOURCES,
         'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
         'hold': {'seconds': a.hold, 'health': []}, 'lifecycle': {}, 'sends': [],
         'limitations': ['不安装runtime；warm不是fresh；不归因本机异常signal；不覆盖Tauri；不是releaseReady']}
    r['cjk'] = {'required': bool(getattr(a, 'font_environment', None)), 'samples': [], 'status': 'not-requested'}
    browser = context = page = None

    def save():
        (out / 'report.json').write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding='utf-8')

    try:
        # host readiness：只需 Playwright 模块和预装 Chromium；不在脚本里 pip/install。
        font_faces, font_child_env = [], None
        if r['cjk']['required']:
            environment = read_font_environment(a.font_environment); font_faces = environment.pop('faces'); font_child_env = environment.pop('childEnv')
            r['cjk'].update(environment={**environment, 'faces': []}, status='pending-actual-rendering')
        import playwright
        from playwright.sync_api import sync_playwright, expect
        from importlib.metadata import version
        r['host'] = {'python': sys.version, 'platform': sys.platform,
                     'playwright': version('playwright'), 'module': str(Path(playwright.__file__).resolve()),
                     'headless': True}
        with sync_playwright() as p:
            assert Path(p.chromium.executable_path).is_file(), 'host Chromium 未就绪，请由 workflow 预装'
            browser = p.chromium.launch(headless=True, env=font_child_env)
            context = browser.new_context(viewport={'width': 1440, 'height': 1000}, locale='zh-CN')
            context.tracing.start(screenshots=True, snapshots=True, sources=True)
            page = context.new_page()
            page.on('pageerror', lambda error: r['errors'].append(str(error)))

            def fixture(name):
                response = context.request.get(a.base_url + '/__qualification/' + name, timeout=15000)
                assert response.status == 200, f'fixture {name}: HTTP {response.status}'
                return response.json()

            def api_response(cmd, data=None, timeout=120000):
                return context.request.post(a.base_url + '/__api/' + cmd, data=data or {}, timeout=timeout)

            def api(cmd, data=None):
                response = api_response(cmd, data)
                assert response.ok, f'{cmd}: HTTP {response.status}; private trace contains body'
                value = response.json()
                assert not isinstance(value, dict) or not value.get('error'), cmd
                return value

            def online():
                expect(page.locator('.hm-chat-gw-status.is-online')).to_be_visible(timeout=90000)
                h = api('hermes_health_check')
                check_health(h, ready['version'])
                return h

            def send(nonce):
                editor, button = page.locator('#hm-chat-input'), page.locator('#hm-chat-send')
                editor.fill(nonce)
                expect(editor).to_have_value(nonce)
                expect(button).to_be_enabled(timeout=10000)
                button.click()
                reply = full_reply(nonce)
                expect(page.get_by_text(reply, exact=True).last).to_be_visible(timeout=120000)
                r['sends'].append({'nonce': nonce, 'method': 'button.click', 'reply': reply, 'fullReplyVisible': True})
                return reply

            def stopped():
                response = api_response('hermes_health_check', timeout=20000)
                assert not response.ok, 'managed stop 后 health 仍在线'
                deadline = time.monotonic() + 10
                while True:
                    s = fixture('snapshot')
                    if s.get('pidsExited') and not s.get('portOpen'):
                        check_offline(s, r['baseline'])
                        return s
                    assert time.monotonic() < deadline, 'managed stop 的 PID/端口未退出'
                    page.wait_for_timeout(200)

            try:
                ready = fixture('ready')
                validate_ready(ready)
                r['ready'] = ready
                before = fixture('snapshot')
                r['provider'] = {'afterSequence': before['providerSequence'], 'receipts': []}
                if before['gatewayRunning']:
                    check_online(before, ready['initial'])
                else:
                    # 第二轮只允许前轮明确 managed-stop；不自动掩盖自然掉线。
                    check_offline(before, ready['initial'])
                    assert before['managedActions'][-1]['action'] == 'stop' and before['managedActions'][-1]['ok'] is True
                page.goto(a.base_url + '/#/h/chat', wait_until='domcontentloaded')
                expect(page.locator('#hm-chat-input')).to_be_visible(timeout=60000)
                expect(page.locator('.hm-chat-gw-status')).to_be_visible(timeout=60000)
                probe = api_response('hermes_health_check', timeout=20000)
                if not probe.ok:
                    assert before['gatewayRunning'] is False, '首次在线 Gateway 自然掉线，不重试'
                    start = page.get_by_role('button', name='启动 Gateway', exact=True)
                    expect(start).to_be_visible(timeout=60000)
                    start.click()
                online()
                r['baseline'] = fixture('snapshot')
                check_online(r['baseline'], ready['initial'])
                r['lifecycle']['initialOnline'] = r['baseline']
                r['steps'].append(expected_steps(a.hold)[0])
                nonce = 'browser-acceptance-' + str(uuid.uuid4())
                reply = send(nonce)
                r['steps'].append(expected_steps(a.hold)[1])
                page.screenshot(path=str(out / 'reply.png'))
                if r['cjk']['required']:
                    sample = capture_cjk_sample(page, page.get_by_text(reply, exact=True).last, reply, 'reply', out / 'reply.png', font_faces)
                    r['cjk']['samples'].append(sample); r['cjk']['environment']['faces'] = sample['matchedFaces']
                    save()
                page.reload(wait_until='domcontentloaded')
                online()
                expect(page.get_by_text(reply, exact=True).last).to_be_visible(timeout=60000)
                r['lifecycle']['historyAfterReload'] = True
                r['steps'].append(expected_steps(a.hold)[2])
                save()
                start_time = time.monotonic()
                for index in range(math.ceil(a.hold / 5)):
                    wait = start_time + index * 5 - time.monotonic()
                    if wait > 0:
                        page.wait_for_timeout(wait * 1000)
                    offset = time.monotonic() - start_time
                    assert index * 5 <= offset < (index + 1) * 5, '错过实际采样窗口，不补采'
                    response = api_response('hermes_health_check', timeout=10000)
                    assert response.status == 200, 'hold health 非200'
                    health = response.json()
                    s = fixture('snapshot')
                    r['hold']['health'].append({'index': index, 'at': utc(), 'offsetSeconds': offset,
                                               'status': response.status, 'health': health, 'snapshot': s})
                    save()
                    check_health(health, ready['version'])
                    check_online(s, r['baseline'])
                    assert s['gatewayIdentity'] == r['baseline']['gatewayIdentity'], 'hold中非预期重启'
                    assert not r['errors'], 'pageerror 原件保留，验收失败'
                wait = start_time + a.hold - time.monotonic()
                if wait > 0:
                    page.wait_for_timeout(wait * 1000)
                r['hold']['elapsedSeconds'] = time.monotonic() - start_time
                assert r['hold']['elapsedSeconds'] >= a.hold
                r['steps'].append(expected_steps(a.hold)[3])
                api('hermes_gateway_action', {'action': 'stop'})
                r['lifecycle']['afterStop'] = stopped()
                r['steps'].append(expected_steps(a.hold)[4])
                api('hermes_gateway_action', {'action': 'start'})
                page.reload(wait_until='domcontentloaded')
                online()
                expect(page.get_by_text(reply, exact=True).last).to_be_visible(timeout=60000)
                r['lifecycle']['restarted'] = fixture('snapshot')
                r['lifecycle']['historyAfterRestart'] = True
                r['steps'].append(expected_steps(a.hold)[5])
                reply2 = send('browser-acceptance-' + str(uuid.uuid4()))
                r['steps'].append(expected_steps(a.hold)[6])
                page.screenshot(path=str(out / 'restarted.png'))
                if r['cjk']['required']:
                    sample = capture_cjk_sample(page, page.get_by_text(reply2, exact=True).last, reply2, 'restarted', out / 'restarted.png', font_faces)
                    r['cjk']['samples'].append(sample)
                    known = {(f['file'], f['index']) for f in r['cjk']['environment']['faces']}
                    r['cjk']['environment']['faces'].extend(f for f in sample['matchedFaces'] if (f['file'], f['index']) not in known)
                    r['cjk']['status'] = 'cmap-and-actual-fonts-verified-png-review-pending'
                    save()
                api('hermes_gateway_action', {'action': 'stop'})
                r['lifecycle']['finalStop'] = stopped()
                expect(page.get_by_text(reply, exact=True).last).to_be_visible(timeout=10000)
                expect(page.get_by_text(reply2, exact=True).last).to_be_visible(timeout=10000)
                r['lifecycle']['finalDataRetained'] = True
                r['steps'].append(expected_steps(a.hold)[7])
                receipts = fixture('receipts')['receipts']
                r['provider']['receipts'] = [x for x in receipts if x['seq'] > r['provider']['afterSequence']]
                assert not r['errors']
                r['ok'] = True
                validate_report(r)
            finally:
                # 捕获失败原件不等于通过；不清空 errors，不补写缺失 step。
                for name, operation in [('final.png', lambda: page.screenshot(path=str(out / 'final.png'))),
                                        ('body-private.txt', lambda: (out / 'body-private.txt').write_text(page.inner_text('body'), encoding='utf-8')),
                                        ('trace.zip', lambda: context.tracing.stop(path=str(out / 'trace.zip')))]:
                    try:
                        operation()
                    except Exception as error:
                        r.setdefault('artifactErrors', []).append({'artifact': name, 'error': redact(error)})
                        r['ok'] = False
                browser.close()
                browser = None
                # close 期间同样保留 pageerror。
                assert not r['errors'], '存在 pageerror'
    except Exception as error:
        r['ok'] = False
        r['error'] = redact(error)
        (out / 'error-private.txt').write_text(traceback.format_exc(), encoding='utf-8')
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception as error:
                r['ok'] = False
                r['closeError'] = redact(error)
        r['finishedAt'] = utc()
        save()
    print(json.dumps({'ok': r['ok'], 'steps': len(r['steps']), 'samples': len(r['hold']['health']),
                      'elapsedSeconds': r['hold'].get('elapsedSeconds'), 'output': str(out),
                      'error': r.get('error')}, ensure_ascii=True))
    return 0 if r['ok'] else 1


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='backslashreplace')
    a = parse_options(argv)
    try:
        return run(a)
    except Exception as error:
        print(json.dumps({'ok': False, 'error': redact(error)}, ensure_ascii=True))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
