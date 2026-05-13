/**
 * Hermes lazy_deps 依赖管理 i18n（P1-3）
 *
 * 11 语言全覆盖（其它语言 fallback 到 en）。
 */
import { _ } from '../helper.js'

export default {
  title: _(
    '可选依赖管理',
    'Optional Dependencies',
    '可選相依套件',
    'オプション依存関係',
    '선택적 의존성',
    'Phụ thuộc tùy chọn',
    'Dependencias opcionales',
    'Dependências opcionais',
    'Дополнительные зависимости',
    'Dépendances optionnelles',
    'Optionale Abhängigkeiten'
  ),
  desc: _(
    '渠道（Telegram / Discord 等）、TTS / STT、搜索引擎等需要单独的 PyPI 包。点「装」一次性预装好，避免启动 Gateway 时卡住。',
    'Channels (Telegram / Discord, etc.), TTS / STT, search backends require additional PyPI packages. Click "Install" to pre-install them once and avoid getting stuck when starting the Gateway.',
    '頻道（Telegram / Discord 等）、TTS / STT、搜尋引擎等需要單獨的 PyPI 套件。點「安裝」一次性預裝好，避免啟動 Gateway 時卡住。',
    'チャンネル（Telegram / Discord 等）、TTS / STT、検索バックエンドには個別の PyPI パッケージが必要です。「インストール」をクリックして事前にインストールし、Gateway 起動時の停滞を回避しましょう。',
    '채널(Telegram / Discord 등), TTS / STT, 검색 백엔드는 별도의 PyPI 패키지가 필요합니다. "설치"를 눌러 미리 설치하여 Gateway 시작 시 멈추는 것을 방지하세요.',
    'Các kênh (Telegram / Discord, v.v.), TTS / STT, công cụ tìm kiếm cần các gói PyPI riêng. Nhấn "Cài đặt" để cài trước, tránh kẹt khi khởi động Gateway.',
    'Los canales (Telegram / Discord, etc.), TTS / STT y motores de búsqueda requieren paquetes PyPI adicionales. Haz clic en "Instalar" para preinstalarlos y evitar que el Gateway se atasque al iniciar.',
    'Os canais (Telegram / Discord, etc.), TTS / STT e backends de busca exigem pacotes PyPI extras. Clique em "Instalar" para pré-instalar e evitar travamentos ao iniciar o Gateway.',
    'Каналы (Telegram / Discord и др.), TTS / STT, поисковые бэкенды требуют отдельных PyPI-пакетов. Нажмите «Установить», чтобы установить заранее и избежать зависания при запуске Gateway.',
    'Les canaux (Telegram / Discord, etc.), TTS / STT et moteurs de recherche nécessitent des paquets PyPI supplémentaires. Cliquez sur « Installer » pour les pré-installer et éviter le blocage au démarrage du Gateway.',
    'Kanäle (Telegram / Discord usw.), TTS / STT und Suchbackends benötigen zusätzliche PyPI-Pakete. Klicken Sie auf „Installieren", um sie vorab zu installieren und Hänger beim Start des Gateways zu vermeiden.'
  ),
  refresh: _('刷新状态', 'Refresh', '重新整理', '更新', '새로고침', 'Làm mới', 'Actualizar', 'Atualizar', 'Обновить', 'Actualiser', 'Aktualisieren'),
  loadFailed: _('加载失败', 'Failed to load', '載入失敗', '読み込み失敗', '불러오기 실패', 'Tải thất bại', 'Error al cargar', 'Falha ao carregar', 'Не удалось загрузить', 'Échec du chargement', 'Laden fehlgeschlagen'),
  emptyTitle: _('暂无可装的依赖', 'No optional dependencies', '暫無可裝的相依套件', 'オプション依存関係なし', '선택적 의존성이 없습니다', 'Không có phụ thuộc tùy chọn', 'No hay dependencias opcionales', 'Nenhuma dependência opcional', 'Нет дополнительных зависимостей', 'Aucune dépendance optionnelle', 'Keine optionalen Abhängigkeiten'),

  installed: _('已装', 'Installed', '已安裝', 'インストール済み', '설치됨', 'Đã cài', 'Instalado', 'Instalado', 'Установлено', 'Installé', 'Installiert'),
  notInstalled: _('未装', 'Not installed', '未安裝', '未インストール', '미설치', 'Chưa cài', 'No instalado', 'Não instalado', 'Не установлено', 'Non installé', 'Nicht installiert'),
  install: _('一键安装', 'Install', '一鍵安裝', 'インストール', '설치', 'Cài đặt', 'Instalar', 'Instalar', 'Установить', 'Installer', 'Installieren'),
  reinstall: _('重新安装', 'Reinstall', '重新安裝', '再インストール', '재설치', 'Cài lại', 'Reinstalar', 'Reinstalar', 'Переустановить', 'Réinstaller', 'Neu installieren'),
  installing: _('安装中', 'Installing', '安裝中', 'インストール中', '설치 중', 'Đang cài', 'Instalando', 'Instalando', 'Установка', 'Installation', 'Installation'),
  installSuccess: _(
    '已成功安装 {feature}', 'Successfully installed {feature}', '已成功安裝 {feature}', '{feature} のインストールに成功しました',
    '{feature} 설치 성공', 'Đã cài đặt {feature} thành công', 'Instalado correctamente: {feature}', '{feature} instalado com sucesso',
    '{feature} успешно установлено', '{feature} installé avec succès', '{feature} erfolgreich installiert'
  ),
  installFailed: _(
    '{feature} 安装失败', 'Failed to install {feature}', '{feature} 安裝失敗', '{feature} のインストールに失敗',
    '{feature} 설치 실패', 'Cài đặt {feature} thất bại', 'Error al instalar {feature}', 'Falha ao instalar {feature}',
    'Не удалось установить {feature}', 'Échec de l\'installation de {feature}', '{feature} Installation fehlgeschlagen'
  ),
  alreadyInstalled: _(
    '{feature} 已经装好了', '{feature} is already installed', '{feature} 已經裝好了', '{feature} は既にインストール済みです',
    '{feature}는 이미 설치되어 있습니다', '{feature} đã được cài', '{feature} ya está instalado', '{feature} já está instalado',
    '{feature} уже установлено', '{feature} est déjà installé', '{feature} ist bereits installiert'
  ),
  installedSpecs: _(
    '已装包：{specs}', 'Installed: {specs}', '已裝套件：{specs}', 'インストール済み: {specs}',
    '설치됨: {specs}', 'Đã cài: {specs}', 'Instalados: {specs}', 'Instalados: {specs}',
    'Установлено: {specs}', 'Installé : {specs}', 'Installiert: {specs}'
  ),
  missingCount: _(
    '缺 {n} 个包', 'Missing {n} package(s)', '缺 {n} 個套件', '{n} 個のパッケージが不足',
    '{n}개 패키지 누락', 'Thiếu {n} gói', 'Faltan {n} paquete(s)', 'Faltam {n} pacote(s)',
    'Не хватает {n} пакетов', 'Manque {n} paquet(s)', 'Fehlen {n} Pakete'
  ),

  catPlatform: _('消息渠道', 'Messaging Channels', '訊息頻道', 'メッセージチャネル', '메시지 채널', 'Kênh nhắn tin', 'Canales de mensajería', 'Canais de mensagens', 'Каналы обмена сообщениями', 'Canaux de messagerie', 'Nachrichtenkanäle'),
  catTts: _('语音合成 (TTS)', 'Text-to-Speech (TTS)', '語音合成 (TTS)', '音声合成 (TTS)', '음성 합성 (TTS)', 'Tổng hợp giọng nói (TTS)', 'Síntesis de voz (TTS)', 'Síntese de voz (TTS)', 'Синтез речи (TTS)', 'Synthèse vocale (TTS)', 'Sprachsynthese (TTS)'),
  catStt: _('语音识别 (STT)', 'Speech-to-Text (STT)', '語音辨識 (STT)', '音声認識 (STT)', '음성 인식 (STT)', 'Nhận dạng giọng nói (STT)', 'Reconocimiento de voz (STT)', 'Reconhecimento de voz (STT)', 'Распознавание речи (STT)', 'Reconnaissance vocale (STT)', 'Spracherkennung (STT)'),
  catSearch: _('搜索引擎', 'Search Engines', '搜尋引擎', '検索エンジン', '검색 엔진', 'Công cụ tìm kiếm', 'Motores de búsqueda', 'Motores de busca', 'Поисковые движки', 'Moteurs de recherche', 'Suchmaschinen'),
  catProvider: _('模型提供商', 'Model Providers', '模型提供商', 'モデルプロバイダー', '모델 제공자', 'Nhà cung cấp mô hình', 'Proveedores de modelos', 'Provedores de modelos', 'Поставщики моделей', 'Fournisseurs de modèles', 'Modellanbieter'),
  catMemory: _('长期记忆', 'Long-term Memory', '長期記憶', '長期記憶', '장기 기억', 'Bộ nhớ dài hạn', 'Memoria a largo plazo', 'Memória de longo prazo', 'Долгосрочная память', 'Mémoire à long terme', 'Langzeitgedächtnis'),
  catImage: _('图像生成', 'Image Generation', '影像生成', '画像生成', '이미지 생성', 'Tạo hình ảnh', 'Generación de imágenes', 'Geração de imagens', 'Генерация изображений', 'Génération d\'images', 'Bildgenerierung'),
  catOther: _('其他', 'Other', '其他', 'その他', '기타', 'Khác', 'Otro', 'Outro', 'Прочее', 'Autre', 'Andere'),

  // 友好显示名（小白看到的不是 platform.telegram 而是「Telegram」）
  featureName: {
    'platform.telegram': _('Telegram', 'Telegram'),
    'platform.discord': _('Discord', 'Discord'),
    'platform.slack': _('Slack', 'Slack'),
    'platform.matrix': _('Matrix', 'Matrix'),
    'platform.dingtalk': _('钉钉', 'DingTalk', '釘釘'),
    'platform.feishu': _('飞书', 'Feishu (Lark)', '飛書'),
    'tts.edge': _('Edge TTS（微软）', 'Edge TTS (Microsoft)', 'Edge TTS（微軟）'),
    'tts.elevenlabs': _('ElevenLabs', 'ElevenLabs'),
    'stt.faster_whisper': _('Faster Whisper（本地）', 'Faster Whisper (local)', 'Faster Whisper（本地）'),
    'search.exa': _('Exa Search', 'Exa Search'),
    'search.firecrawl': _('Firecrawl', 'Firecrawl'),
    'search.parallel': _('Parallel.ai Web', 'Parallel.ai Web'),
    'provider.anthropic': _('Anthropic（原生 SDK）', 'Anthropic (native SDK)', 'Anthropic（原生 SDK）'),
    'provider.bedrock': _('AWS Bedrock', 'AWS Bedrock'),
    'memory.honcho': _('Honcho 记忆', 'Honcho Memory', 'Honcho 記憶'),
    'memory.hindsight': _('Hindsight 记忆', 'Hindsight Memory', 'Hindsight 記憶'),
    'image.fal': _('FAL 图像', 'FAL Image', 'FAL 影像'),
  },
}
