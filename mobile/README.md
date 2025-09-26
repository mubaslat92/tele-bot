# Mobile (Flutter)

This folder hosts the Flutter app (Android/iOS) for quick capture and insights.

## Structure
- `ledger_mobile/` – Flutter project

## Dev quick start
1. Install Flutter SDK and Android Studio (for emulators).
2. From this folder:
   - `flutter pub get`
   - Run with:
     - Android emulator: `flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8090 --dart-define=API_TOKEN=YOUR_TOKEN`
     - Physical device on same LAN: use your machine IP instead of 10.0.2.2.
3. The Home screen calls `/api/summary` and has a demo button that POSTs to `/api/mobile/entry`.

## Notes
- Tokens are passed via `--dart-define` for dev only; move to `flutter_secure_storage` for production.
- For iOS builds you’ll need macOS/Xcode.
