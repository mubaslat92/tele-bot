# Mobile App (Flutter)

Minimal ledger client for quick add + summary.

## Features (v1.1)
- Home: Summary cards, Top categories, Recent entries.
- Month-year picker dialog (tap year to type input), no day selection.
- Quick add bottom sheet with Amount, Category dropdown, Description, Currency.
- Sends one-letter category code (uppercase) separately; description remains unchanged.

## Run (Android emulator)

The emulator cannot call `localhost` on your PC—use `10.0.2.2` to reach the backend listening on your PC.

```powershell
cd C:\Users\hamza\Projects\telegram-ledger-bot\mobile\ledger_mobile
flutter devices            # confirm emulator-5554 exists
flutter run -d emulator-5554 --dart-define=API_BASE_URL=http://10.0.2.2:8090
```

Hot reload: `r`   Hot restart: `R`

If you enable API auth in the server, wire the token via Dio headers in `lib/src/api.dart` (uses `API_TOKEN` if provided as a dart-define).
