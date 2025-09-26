import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../src/api.dart';

final apiProvider = Provider<ApiClient>((ref) {
  // For dev, point to your local backend. Change to your prod URL later.
  const base = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:8090');
  // If you use dashboardAuthToken, set it in code for dev only; move to secure storage later.
  const token = String.fromEnvironment('API_TOKEN', defaultValue: '');
  return ApiClient(baseUrl: base, token: token);
});

class HomeScreen extends HookConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.watch(apiProvider);
    final month = useState(DateTime.now().toUtc());
    final loading = useState(false);
    final summary = useState<SummaryResp?>(null);
    final error = useState<String?>(null);

    Future<void> load() async {
      loading.value = true; error.value = null;
      final ym = '${month.value.year}-${month.value.month.toString().padLeft(2,'0')}' ;
      try {
        final r = await api.get('/api/summary', query: {'month': ym});
        final data = SummaryResp.fromJson(r.data as Map<String, dynamic>);
        summary.value = data;
      } catch (e) {
        error.value = e.toString();
      } finally {
        loading.value = false;
      }
    }

    useEffect(() { load(); return null; }, const []);

    return Scaffold(
      appBar: AppBar(title: const Text('Ledger')),
      body: RefreshIndicator(
        onRefresh: load,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Month: ${DateUtils.dateOnly(month.value).toString().substring(0,7)}', style: Theme.of(context).textTheme.titleMedium),
                Row(children: [
                  IconButton(onPressed: () { final d = DateTime.utc(month.value.year, month.value.month-1, 1); month.value = d; load(); }, icon: const Icon(Icons.chevron_left)),
                  IconButton(onPressed: () { final d = DateTime.utc(month.value.year, month.value.month+1, 1); month.value = d; load(); }, icon: const Icon(Icons.chevron_right)),
                ])
              ],
            ),
            const SizedBox(height: 12),
            if (loading.value) const LinearProgressIndicator(),
            if (error.value != null) Text(error.value!, style: const TextStyle(color: Colors.red)),
            if (summary.value != null) _SummaryCards(s: summary.value!),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('Quick add demo entry'),
              onPressed: () async {
                try {
                  await api.post('/api/mobile/entry', data: {
                    'amount': 3.25,
                    'currency': 'JOD',
                    'description': 'snack 3.25 cafe',
                  });
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Entry created')));
                    await load();
                  }
                } catch (e) {
                  if (context.mounted){
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
                  }
                }
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _SummaryCards extends StatelessWidget {
  final SummaryResp s;
  const _SummaryCards({required this.s});
  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(child: _Card(label: 'Out', value: s.totalExpense.toStringAsFixed(2))),
        const SizedBox(width: 12),
        Expanded(child: _Card(label: 'In', value: s.totalIncome.toStringAsFixed(2))),
        const SizedBox(width: 12),
        Expanded(child: _Card(label: 'Count', value: s.count.toString())),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  final String label;
  final String value;
  const _Card({required this.label, required this.value});
  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: 8),
          Text(value, style: Theme.of(context).textTheme.headlineSmall),
        ]),
      ),
    );
  }
}
