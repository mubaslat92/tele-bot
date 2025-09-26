import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../src/api.dart';
import '../home/home_screen.dart' show apiProvider;

class EntriesScreen extends HookConsumerWidget {
  const EntriesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.watch(apiProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Recent entries')),
      body: _EntriesBody(api: api),
    );
  }
}

class _EntriesBody extends StatefulWidget {
  final ApiClient api;
  const _EntriesBody({required this.api});
  @override
  State<_EntriesBody> createState() => _EntriesBodyState();
}

class _EntriesBodyState extends State<_EntriesBody> {
  bool _loading = false;
  String? _error;
  List<_Entry> _items = [];

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final ym = DateTime.now();
      final m = '${ym.year}-${ym.month.toString().padLeft(2,'0')}';
      final r = await widget.api.get('/api/entries', query: { 'month': m, 'limit': 200 });
      final json = r.data as Map<String, dynamic>;
      final data = (json['data'] as List).cast<Map<String, dynamic>>();
      _items = data.map((e) => _Entry(
        id: (e['id'] ?? 0) as int,
        date: (e['createdAt'] ?? e['created_at'] ?? '') as String,
        code: (e['code'] ?? '') as String,
        amount: (e['amount'] as num?)?.toDouble() ?? 0,
        currency: (e['currency'] ?? '') as String,
        description: (e['description'] ?? '') as String,
      )).toList();
    } catch (e) { _error = e.toString(); }
    finally { if (mounted) setState(() { _loading = false; }); }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!, style: const TextStyle(color: Colors.red)));
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        itemCount: _items.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (_, i) {
          final e = _items[i];
          return ListTile(
            title: Text(e.description),
            subtitle: Text('${e.date}  ·  ${e.code}'),
            trailing: Text('${e.amount.toStringAsFixed(2)} ${e.currency}'),
          );
        },
      ),
    );
  }
}

class _Entry {
  final int id; final String date; final String code; final double amount; final String currency; final String description;
  _Entry({required this.id, required this.date, required this.code, required this.amount, required this.currency, required this.description});
}
