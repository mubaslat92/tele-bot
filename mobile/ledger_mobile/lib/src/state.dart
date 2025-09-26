import 'package:hooks_riverpod/hooks_riverpod.dart';

// Global month selection shared across screens
final monthProvider = StateProvider<DateTime>((ref) {
  final now = DateTime.now().toUtc();
  return DateTime.utc(now.year, now.month, 1);
});
