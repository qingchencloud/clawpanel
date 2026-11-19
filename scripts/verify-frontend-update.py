"""核验线上桌面清单、下载内容和入口。只读，不安装客户端。"""

import argparse
import hashlib
import http.client
import io
import json
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from zipfile import ZipFile


def fetch(url):
    if urlsplit(url).hostname == "claw.qt.cool":
        url += ("&" if "?" in url else "?") + "_t=" + str(time.time_ns())
    # 同源跳转复用 HTTPS 连接，保持短时下载票据的请求来源一致。
    conn = origin = None
    try:
        for _ in range(6):
            target = urlsplit(url)
            if target.scheme != "https" or not target.hostname:
                raise ValueError("更新下载地址必须使用 HTTPS")
            if target.netloc != origin:
                if conn:
                    conn.close()
                conn = http.client.HTTPSConnection(target.hostname, target.port, timeout=90)
                origin = target.netloc
            path = urlunsplit(("", "", target.path or "/", target.query, ""))
            conn.request("GET", path, headers={"User-Agent": "ClawPanel", "Cache-Control": "no-cache"})
            response = conn.getresponse()
            body = response.read()
            if response.status == 200:
                return body
            redirect = response.getheader("Location")
            if response.status not in (301, 302, 303, 307, 308) or not redirect:
                raise RuntimeError(f"{target.hostname} HTTP {response.status}")
            url = urljoin(url, redirect)
        raise RuntimeError("下载重定向次数过多")
    finally:
        if conn:
            conn.close()


def verify(url, release_file):
    release = json.loads(release_file.read_bytes())
    manifest = json.loads(fetch(url))
    package = fetch(manifest["url"])
    digest = "sha256:" + hashlib.sha256(package).hexdigest()
    with ZipFile(io.BytesIO(package)) as archive:
        entries = archive.namelist()
        root_html = "index.html" in entries and len(archive.read("index.html")) > 0
        bad_entry = archive.testzip()
    checks = {
        "version": manifest["version"] == release["version"],
        "minAppVersion": manifest["minAppVersion"] == release["minAppVersion"],
        "sha256": digest == manifest["hash"] == release["hash"],
        "size": len(package) == manifest["size"] == release["size"],
        "rootIndex": root_html,
        "archiveIntegrity": bad_entry is None,
    }
    return {
        "manifestUrl": url, "assetUrl": manifest["url"], "version": manifest["version"],
        "minAppVersion": manifest["minAppVersion"], "bytes": len(package),
        "sha256": digest, "checks": checks, "ok": all(checks.values()),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://claw.qt.cool/update/latest.json")
    parser.add_argument("--release-file", type=Path, default=Path(__file__).resolve().parents[1] / "docs/update/latest.json")
    args = parser.parse_args()
    result = verify(args.url, args.release_file)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["ok"] else 1)
