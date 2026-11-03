"""官方隔离进程：实际Hermes Gateway /v1/runs，SDK与agent禁重试。"""
import json
import sys
import uuid
import urllib.parse


def main():
    dto = json.loads(sys.stdin.readline(1048576))
    url = urllib.parse.urlsplit(dto.get('baseUrl', ''))
    import re
    if (dto.get('engine') != 'hermes' or dto.get('providerId') != 'clawpanel-official'
            or dto.get('apiKey') != 'clawpanel-local' or url.scheme != 'http'
            or url.hostname != '127.0.0.1' or not url.port or url.username or url.password
            or url.query or url.fragment or not re.fullmatch(r'/engine/[A-Za-z0-9_-]{16,128}/v1', url.path)):
        raise RuntimeError('official_connection_invalid')
    import os
    os.environ['CUSTOM_BASE_URL'] = dto['baseUrl']
    import logging
    original_record_factory = logging.getLogRecordFactory()
    def private_record_factory(*args, **kwargs):
        record = original_record_factory(*args, **kwargs)
        record.msg = record.getMessage().replace(dto['baseUrl'], '<official-local-gateway>').replace(url.path.split('/')[2], '<local-capability>')
        record.args = ()
        return record
    logging.setLogRecordFactory(private_record_factory)
    # Hermes本地usage数据库会持久化billing route；只留provider标识，不把局部能力写入WAL。
    from hermes_state import SessionDB
    for method_name, field in [('update_token_counts', 'billing_base_url'), ('update_session_billing_route', 'base_url')]:
        original_method = getattr(SessionDB, method_name)
        def safe_route(instance, *args, _method=original_method, _field=field, **kwargs):
            if _field in kwargs:
                kwargs[_field] = 'clawpanel-official'
            return _method(instance, *args, **kwargs)
        setattr(SessionDB, method_name, safe_route)
    allowed = {item['id'] for item in dto['models']}
    selected_id = dto.get('modelId') or (dto['models'][0]['id'] if len(dto['models']) == 1 else None)
    selected = next((item for item in dto['models'] if item['id'] == selected_id), None)
    if (not selected or not isinstance(selected.get('capabilities', {}).get('tool_calls'), bool)
            or (selected['capabilities']['tool_calls'] is False and dto.get('textOnly') is not True)
            or (selected['capabilities']['tool_calls'] is True and dto.get('textOnly') is True)
            or ('toolsAvailable' in dto and dto['toolsAvailable'] != selected['capabilities']['tool_calls'])):
        raise RuntimeError('official_model_mode_invalid')
    text_only = dto.get('textOnly') is True
    # Gateway在创建AIAgent之前也解析provider；明确内存覆盖，不探测磁盘placeholder。
    import hermes_cli.runtime_provider as provider_runtime
    original_resolve = provider_runtime.resolve_runtime_provider
    def official_resolve(**kwargs):
        kwargs.update(requested='custom', explicit_api_key=dto['apiKey'], explicit_base_url=dto['baseUrl'])
        return original_resolve(**kwargs)
    provider_runtime.resolve_runtime_provider = official_resolve
    import run_agent
    original_init = run_agent.AIAgent.__init__
    # 原运行时错误快照包含完整路由URL；官方原操作由native安全journal保留。
    run_agent.AIAgent._dump_api_request_debug = lambda *_args, **_kwargs: None
    original_copy_reasoning = run_agent.AIAgent._copy_reasoning_content_for_api
    original_reapply_reasoning = run_agent.AIAgent._reapply_reasoning_echo_for_provider
    def same_official_route(agent):
        return (agent.provider == 'custom' and agent.model == selected_id
                and str(agent.base_url).rstrip('/') == dto['baseUrl']
                and agent.api_mode == 'chat_completions')
    def copy_official_reasoning(agent, source_message, api_message):
        received = source_message.get('reasoning_content')
        original_copy_reasoning(agent, source_message, api_message)
        # 此隔离进程固定同一官方模型且禁fallback；本机custom路由不是跨供应商切换。
        # 仅回传原响应已有字符串，不按模型名猜能力、不补空白思考内容。
        if same_official_route(agent) and source_message.get('role') == 'assistant' and isinstance(received, str):
            api_message['reasoning_content'] = received
    def reapply_official_reasoning(agent, api_messages):
        if same_official_route(agent):
            return 0
        return original_reapply_reasoning(agent, api_messages)
    run_agent.AIAgent._copy_reasoning_content_for_api = copy_official_reasoning
    run_agent.AIAgent._reapply_reasoning_echo_for_provider = reapply_official_reasoning

    class OfficialStream:
        def __init__(self, source, release):
            self.source, self.release = source, release
        def __iter__(self):
            finished = False
            for chunk in self.source:
                if any(choice.finish_reason is not None for choice in chunk.choices):
                    finished = True
                yield chunk
            if finished:
                self.release()
        def __getattr__(self, key):
            return getattr(self.source, key)
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.source.close()

    def official_init(agent, *args, **kwargs):
        if args:
            raise RuntimeError('official_runtime_constructor_unsupported')
        kwargs.update(base_url=dto['baseUrl'], api_key=dto['apiKey'], provider='custom',
                      api_mode='chat_completions', fallback_model=None, quiet_mode=True,
                      skip_context_files=True, skip_memory=True,
                      enabled_toolsets=[] if text_only else ['terminal', 'file', 'todo'])
        if kwargs.get('model') not in allowed or kwargs.get('model') != selected_id:
            raise RuntimeError('official_model_not_allowed')
        metadata = next(item for item in dto['models'] if item['id'] == kwargs['model'])
        kwargs['max_tokens'] = min(int(metadata.get('max_output_tokens', 128)), 8192)
        original_init(agent, **kwargs)
        if text_only and agent.tools:
            raise RuntimeError('official_text_only_tools_unavailable')
        agent._api_max_retries = 1
        agent._fallback_chain = []
        agent._fallback_model = None
        agent.client.max_retries = 0
    import openai
    from openai.resources.chat.completions import Completions
    original_create = Completions.create
    original_client_init = openai.OpenAI.__init__
    def client_init(client, *args, **kwargs):
        kwargs.update(base_url=dto['baseUrl'], api_key=dto['apiKey'], max_retries=0)
        original_client_init(client, *args, **kwargs)
    openai.OpenAI.__init__ = client_init
    pending = [None]
    def create(resource, *call_args, **call_kwargs):
        if call_kwargs.get('model') not in allowed or call_kwargs.get('model') != selected_id:
            raise RuntimeError('official_model_not_allowed')
        if text_only and call_kwargs.get('tools'):
            raise RuntimeError('official_text_only_tools_unavailable')
        pending[0] = pending[0] or uuid.uuid4().hex
        operation = pending[0]
        headers = dict(call_kwargs.get('extra_headers') or {})
        headers['X-ClawPanel-Operation-ID'] = operation
        call_kwargs['extra_headers'] = headers
        for message in call_kwargs.get('messages', []):
            content = message.get('content')
            if isinstance(content, list) and all(isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str) for part in content):
                message['content'] = ''.join(part['text'] for part in content)
        if call_kwargs.get('tools'):
            call_kwargs['parallel_tool_calls'] = False
        # 工具/未知字段保留，由官网严格验证；不改写为其他协议或降级模型。
        result = original_create(resource, *call_args, **call_kwargs)
        def release():
            if pending[0] == operation:
                pending[0] = None
        if call_kwargs.get('stream'):
            return OfficialStream(result, release)
        if any(choice.finish_reason is not None for choice in result.choices):
            release()
        return result
    Completions.create = create
    run_agent.AIAgent.__init__ = official_init
    # stdin是本native父进程私有管道；EOF只对当前HERMES_HOME/本人PID申请正常停机。
    import threading
    def watch_parent():
        sys.stdin.read()
        # 不同版本若正常停机机制失效，兜底只退出本进程，绝不扫描/终止其他Gateway。
        fallback = threading.Timer(15, lambda: os._exit(1))
        fallback.daemon = True
        fallback.start()
        try:
            from gateway.status import write_planned_stop_marker
            if not write_planned_stop_marker(os.getpid()):
                logging.getLogger(__name__).error('official_parent_eof_stop_unavailable')
        except Exception:
            logging.getLogger(__name__).error('official_parent_eof_stop_unavailable')
    threading.Thread(target=watch_parent, name='official-parent-eof', daemon=True).start()
    from hermes_cli.main import main as hermes_main
    sys.argv = ['hermes', 'gateway']
    hermes_main()


if __name__ == '__main__':
    main()
