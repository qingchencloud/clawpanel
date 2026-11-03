(() => {
  // 本页不保留授权参数；不读取、不记录、不复制查询内容。
  try { history.replaceState(null, '', location.pathname); } catch {}

  const messages = {
    'zh-CN': {
      documentTitle: 'ClawPanel · 官网授权',
      received: { heading: '授权已接收', returnHint: '请返回 ClawPanel 继续', resultHint: '登录结果以客户端显示为准。', instruction: '切回 ClawPanel，查看登录状态。', instructionDetail: '你可以关闭此页面。' },
      denied: { heading: '已取消授权', returnHint: '请返回 ClawPanel', resultHint: '本次授权已取消，可在客户端重新登录。', instruction: '无需在此页面继续操作。', instructionDetail: '如需登录，请返回客户端重试。' },
      rejected: { heading: '授权未完成', returnHint: '请返回 ClawPanel 重试', resultHint: '此页面已失效或无法确认。', instruction: '返回客户端，重新发起官网登录。', instructionDetail: '请勿重复提交此页面。' },
      close: '关闭此页',
      closeFallback: '浏览器未关闭，请手动关闭此标签页。',
      footer: 'ClawPanel · 原有模型与会话保留'
    },
    en: {
      documentTitle: 'ClawPanel · Website authorization',
      received: { heading: 'Authorization received', returnHint: 'Return to ClawPanel to continue', resultHint: 'Check the app for your sign-in result.', instruction: 'Return to ClawPanel to check your sign-in status.', instructionDetail: 'You can close this page.' },
      denied: { heading: 'Authorization cancelled', returnHint: 'Return to ClawPanel', resultHint: 'Authorization was cancelled. Sign in again in the app.', instruction: 'No further action is needed on this page.', instructionDetail: 'Return to the app if you want to try again.' },
      rejected: { heading: 'Authorization incomplete', returnHint: 'Return to ClawPanel to try again', resultHint: 'This page has expired or could not be verified.', instruction: 'Start website sign-in again from the app.', instructionDetail: 'Do not submit this page again.' },
      close: 'Close this page',
      closeFallback: 'The browser did not close. Please close this tab manually.',
      footer: 'ClawPanel · Your existing models and conversations stay'
    }
  };
  const root = document.documentElement;
  const outcome = ['received', 'denied', 'rejected'].includes(root.dataset.outcome) ? root.dataset.outcome : 'rejected';
  const languageButtons = document.querySelectorAll('[data-language]');
  function language(value) {
    const lang = value === 'en' ? 'en' : 'zh-CN';
    const dictionary = messages[lang];
    const copy = { ...dictionary, ...dictionary[outcome] };
    root.lang = lang;
    document.title = dictionary.documentTitle;
    document.querySelectorAll('[data-copy]').forEach(element => {
      const text = copy[element.dataset.copy];
      if (typeof text === 'string') element.textContent = text;
    });
    languageButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.language === lang)));
  }
  languageButtons.forEach(button => button.addEventListener('click', () => language(button.dataset.language)));
  document.querySelector('[data-close]').addEventListener('click', () => {
    try { window.close(); } catch {}
    setTimeout(() => { document.querySelector('[data-close-fallback]').hidden = false; }, 150);
  });
  language(root.lang);
})();
