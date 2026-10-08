# AI Threads 5.6.5 — комплект выпуска

В builds/ находятся ZIP и подписанные CRX для всех трёх платформ.
Исправления поведения и проверки описаны в FIXES.md.

- Android: builds/extension-android.crx
- iPhone/iPad: builds/extension-mobile.crx
- Компьютер: распакованная папка extension/; также builds/extension-desktop.zip

Установку CRX должен поддерживать выбранный браузер. Реальные мобильные
устройства не тестировались. После установки проверьте один выбранный ответ
перед включением автокомментинга.

Выпуск подписан ключами выданного ранее выпуска 5.6.4; ID сохраняются:

- desktop: `abjlkmngohalallfmfeipdmbmidimfgh`
- android: `eogpdkefaogkfnnneadeopgalhejhkcj`
- mobile: `apppkoopmnempekajjgkadhhefjehkhb`

Для CRX 5.6.4 из нашей сборки ID сохраняются. Исходные CRX из присланного builds.zip имеют другие ID. Сохраните настройки перед удалением старой установки.
Приватные ключи хранятся в отдельном архиве signing-keys-private. Не публикуйте его.
Чтобы сохранить ID при следующем выпуске, распакуйте этот архив в корень проекта,
затем выполните node tools/release.mjs release НОВАЯ_ВЕРСИЯ.

Это комплект браузерного расширения. Серверная часть не входила в исходный проект.
