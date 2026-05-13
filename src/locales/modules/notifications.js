/**
 * 推送通知 i18n（P1-0）
 */
import { _ } from '../helper.js'

export default {
  title: _('推送通知', 'Push Notifications', '推送通知', 'プッシュ通知', '푸시 알림', 'Thông báo đẩy', 'Notificaciones push', 'Notificações push', 'Push-уведомления', 'Notifications push', 'Push-Benachrichtigungen'),
  desc: _(
    '即使 ClawPanel 关掉，Windows / macOS / iOS 通知中心也能收到 Agent / Cron / 渠道消息',
    'Receive Agent / Cron / channel messages in Windows / macOS / iOS notification center even when ClawPanel is closed',
    '即使 ClawPanel 關掉，Windows / macOS / iOS 通知中心也能收到 Agent / Cron / 頻道訊息',
    'ClawPanel を閉じても、Windows / macOS / iOS の通知センターで Agent / Cron / チャネルメッセージを受信',
    'ClawPanel을 닫아도 Windows / macOS / iOS 알림 센터에서 Agent / Cron / 채널 메시지 수신',
    'Nhận tin nhắn Agent / Cron / kênh ngay cả khi ClawPanel đã đóng',
    'Recibe mensajes de Agent / Cron / canal incluso con ClawPanel cerrado',
    'Receba mensagens de Agent / Cron / canal mesmo com o ClawPanel fechado',
    'Получайте сообщения Agent / Cron / каналов даже когда ClawPanel закрыт',
    'Recevez les messages Agent / Cron / canal même lorsque ClawPanel est fermé',
    'Empfange Agent / Cron / Kanal-Nachrichten auch bei geschlossenem ClawPanel'
  ),
  statusTitle: _('当前状态', 'Current Status', '當前狀態', '現在のステータス', '현재 상태', 'Trạng thái', 'Estado actual', 'Status atual', 'Текущий статус', 'État actuel', 'Aktueller Status'),
  permissionLabel: _('通知权限', 'Notification Permission', '通知權限', '通知許可', '알림 권한', 'Quyền thông báo', 'Permiso de notificación', 'Permissão de notificação', 'Разрешение уведомлений', 'Permission notification', 'Benachrichtigungsberechtigung'),
  subscriptionLabel: _('订阅状态', 'Subscription', '訂閱狀態', '購読状態', '구독 상태', 'Trạng thái đăng ký', 'Suscripción', 'Inscrição', 'Подписка', 'Abonnement', 'Abonnement'),
  endpointLabel: _('订阅端点：', 'Endpoint:', '訂閱端點：', 'エンドポイント:', '엔드포인트:', 'Endpoint:', 'Endpoint:', 'Endpoint:', 'Endpoint:', 'Endpoint :', 'Endpoint:'),
  subscribed: _('已订阅', 'Subscribed', '已訂閱', '購読済み', '구독됨', 'Đã đăng ký', 'Suscrito', 'Inscrito', 'Подписан', 'Abonné', 'Abonniert'),
  notSubscribed: _('未订阅', 'Not Subscribed', '未訂閱', '未購読', '미구독', 'Chưa đăng ký', 'No suscrito', 'Não inscrito', 'Не подписан', 'Non abonné', 'Nicht abonniert'),
  permGranted: _('已授权', 'Granted', '已授權', '許可済み', '허용됨', 'Đã cấp', 'Concedido', 'Concedido', 'Разрешено', 'Accordée', 'Erteilt'),
  permDenied: _('已拒绝', 'Denied', '已拒絕', '拒否済み', '거부됨', 'Đã từ chối', 'Denegado', 'Negado', 'Отклонено', 'Refusée', 'Verweigert'),
  permDefault: _('未询问', 'Not asked', '未詢問', '未確認', '미요청', 'Chưa hỏi', 'Sin solicitar', 'Não solicitado', 'Не запрошено', 'Non demandée', 'Nicht angefragt'),
  permUnsupported: _('不支持', 'Unsupported', '不支援', '非対応', '미지원', 'Không hỗ trợ', 'No soportado', 'Não suportado', 'Не поддерживается', 'Non supporté', 'Nicht unterstützt'),

  actionsTitle: _('操作', 'Actions', '操作', 'アクション', '동작', 'Hành động', 'Acciones', 'Ações', 'Действия', 'Actions', 'Aktionen'),
  subscribeBtn: _('启用推送通知', 'Enable Push', '啟用推送通知', '通知を有効化', '푸시 활성화', 'Bật thông báo', 'Activar notificaciones', 'Ativar notificações', 'Включить уведомления', 'Activer les notifications', 'Push aktivieren'),
  unsubscribeBtn: _('取消订阅', 'Unsubscribe', '取消訂閱', '購読解除', '구독 해제', 'Hủy đăng ký', 'Cancelar suscripción', 'Cancelar inscrição', 'Отписаться', 'Se désabonner', 'Abmelden'),
  testBtn: _('发测试通知', 'Send Test', '發測試通知', 'テスト通知を送信', '테스트 알림 전송', 'Gửi thử', 'Enviar prueba', 'Enviar teste', 'Тестовое уведомление', 'Envoyer un test', 'Test senden'),
  subscribing: _('订阅中', 'Subscribing', '訂閱中', '購読中', '구독 중', 'Đang đăng ký', 'Suscribiendo', 'Inscrevendo', 'Подписка', 'Abonnement en cours', 'Abonnieren'),
  sending: _('发送中', 'Sending', '發送中', '送信中', '전송 중', 'Đang gửi', 'Enviando', 'Enviando', 'Отправка', 'Envoi', 'Senden'),

  hint: _(
    '点「启用」后浏览器会弹权限请求。授权后即使关掉 ClawPanel 也能收通知。',
    'Click "Enable" — the browser will ask for permission. Once granted, notifications arrive even if ClawPanel is closed.',
    '點「啟用」後瀏覽器會彈權限請求。授權後即使關掉 ClawPanel 也能收通知。',
    '「有効化」をクリックするとブラウザが権限を要求します。許可後は ClawPanel を閉じていても通知が届きます。',
    '"활성화"를 클릭하면 브라우저가 권한을 요청합니다. 허용 후에는 ClawPanel을 닫아도 알림을 받을 수 있습니다.',
    'Nhấn "Bật" — trình duyệt sẽ yêu cầu quyền. Sau khi cấp, thông báo vẫn đến khi ClawPanel đã đóng.',
    'Haz clic en "Activar"; el navegador pedirá permiso. Una vez concedido, recibirás notificaciones aunque ClawPanel esté cerrado.',
    'Clique em "Ativar"; o navegador pedirá permissão. Após concedida, você recebe notificações mesmo com o ClawPanel fechado.',
    'Нажмите «Включить» — браузер запросит разрешение. После согласия уведомления будут приходить, даже если ClawPanel закрыт.',
    'Cliquez sur « Activer » — le navigateur demandera la permission. Une fois accordée, les notifications arrivent même si ClawPanel est fermé.',
    'Klicken Sie auf „Aktivieren" — der Browser fragt nach Berechtigung. Nach Erteilung kommen Benachrichtigungen auch bei geschlossenem ClawPanel.'
  ),

  subscribeSuccess: _('推送通知已启用 ✓', 'Push enabled ✓', '推送通知已啟用 ✓', '通知を有効化しました ✓', '푸시 활성화됨 ✓', 'Đã bật thông báo ✓', 'Notificaciones activadas ✓', 'Notificações ativadas ✓', 'Уведомления включены ✓', 'Notifications activées ✓', 'Push aktiviert ✓'),
  subscribeFailed: _('启用推送失败', 'Failed to enable push', '啟用推送失敗', '通知の有効化に失敗', '푸시 활성화 실패', 'Không bật được thông báo', 'No se pudieron activar las notificaciones', 'Falha ao ativar notificações', 'Не удалось включить уведомления', 'Échec de l\'activation des notifications', 'Push-Aktivierung fehlgeschlagen'),
  unsubscribeSuccess: _('已取消订阅', 'Unsubscribed', '已取消訂閱', '購読を解除しました', '구독 해제됨', 'Đã hủy đăng ký', 'Suscripción cancelada', 'Inscrição cancelada', 'Подписка отменена', 'Désabonné', 'Abgemeldet'),
  unsubscribeFailed: _('取消订阅失败', 'Failed to unsubscribe', '取消訂閱失敗', '購読解除に失敗', '구독 해제 실패', 'Hủy đăng ký thất bại', 'No se pudo cancelar la suscripción', 'Falha ao cancelar inscrição', 'Не удалось отписаться', 'Échec du désabonnement', 'Abmeldung fehlgeschlagen'),

  testTitle: _('ClawPanel 测试通知', 'ClawPanel Test', 'ClawPanel 測試通知', 'ClawPanel テスト通知', 'ClawPanel 테스트 알림', 'Thử ClawPanel', 'Prueba ClawPanel', 'Teste ClawPanel', 'Тест ClawPanel', 'Test ClawPanel', 'ClawPanel-Test'),
  testBody: _('推送链路已通 ✓ 后续 Agent/Cron 消息会从这里出现', 'Push link is working ✓ future Agent/Cron messages will appear here', '推送鏈路已通 ✓ 後續 Agent/Cron 訊息會從這裡出現', 'プッシュ通知の経路が確認できました ✓', '푸시 경로 확인됨 ✓', 'Đường dẫn thông báo đã thông ✓', 'Canal de push funcionando ✓', 'Canal de push funcionando ✓', 'Канал push работает ✓', 'Liaison push opérationnelle ✓', 'Push-Verbindung funktioniert ✓'),
  testSent: _('测试通知已发出', 'Test notification sent', '測試通知已發出', 'テスト通知を送信しました', '테스트 알림 전송됨', 'Đã gửi thông báo thử', 'Notificación de prueba enviada', 'Notificação de teste enviada', 'Тестовое уведомление отправлено', 'Notification de test envoyée', 'Testbenachrichtigung gesendet'),
  testDelivered: _('已投递到 {n} 个订阅', 'Delivered to {n} subscription(s)', '已投遞到 {n} 個訂閱', '{n} 件の購読に配信', '{n}개 구독에 전달됨', 'Đã gửi tới {n} đăng ký', 'Entregada a {n} suscripción(es)', 'Entregue a {n} inscrição(ões)', 'Доставлено в {n} подписок', 'Livré à {n} abonnement(s)', 'An {n} Abonnement(s) zugestellt'),
  testFailed: _('测试通知发送失败', 'Failed to send test', '測試通知發送失敗', 'テスト通知の送信に失敗', '테스트 알림 전송 실패', 'Gửi thử thất bại', 'No se pudo enviar la prueba', 'Falha ao enviar teste', 'Не удалось отправить тест', 'Échec de l\'envoi du test', 'Testversand fehlgeschlagen'),

  unsupportedTitle: _('当前环境不支持推送', 'Push not supported here', '當前環境不支援推送', 'この環境ではプッシュ通知非対応', '이 환경은 푸시 미지원', 'Môi trường này không hỗ trợ', 'No soportado en este entorno', 'Não suportado neste ambiente', 'Push не поддерживается', 'Push non pris en charge', 'Push hier nicht unterstützt'),
  unsupportedDesc: _(
    '推送通知需要 Service Worker + PushManager + Notification API。Tauri 桌面壳层可能不支持；请在浏览器（Web 模式）下使用，或升级到支持该功能的版本。',
    'Web Push needs Service Worker + PushManager + Notification API. The Tauri desktop shell may not support it — please use Web mode (browser).',
    '推送通知需要 Service Worker + PushManager + Notification API。Tauri 桌面殼層可能不支援；請在瀏覽器（Web 模式）下使用。',
    'プッシュ通知には Service Worker + PushManager + Notification API が必要です。Tauri デスクトップシェルでは未対応の場合があります。',
    '푸시 알림에는 Service Worker + PushManager + Notification API가 필요합니다.',
    'Thông báo đẩy cần Service Worker + PushManager + Notification API.',
    'Las notificaciones push requieren Service Worker + PushManager + Notification API.',
    'As notificações push exigem Service Worker + PushManager + Notification API.',
    'Push-уведомления требуют Service Worker + PushManager + Notification API.',
    'Les notifications push nécessitent Service Worker + PushManager + Notification API.',
    'Push-Benachrichtigungen erfordern Service Worker + PushManager + Notification API.'
  ),
}
