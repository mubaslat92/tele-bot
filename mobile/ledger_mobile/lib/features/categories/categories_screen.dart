import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../src/api.dart';
import '../home/home_screen.dart' show apiProvider;

class CategoriesScreen extends HookConsumerWidget {
  const CategoriesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.watch(apiProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('By category')),
      body: _CategoriesBody(api: api),
    );
  }
}

class _CategoriesBody extends StatefulWidget {
  final ApiClient api;
  const _CategoriesBody({required this.api});
  @override
  State<_CategoriesBody> createState() => _CategoriesBodyState();
}

class _CategoriesBodyState extends State<_CategoriesBody> {
  bool _loading = false;
  String? _error;
  List<_Cat> _items = [];

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final ym = DateTime.now();
      final m = '${ym.year}-${ym.month.toString().padLeft(2,'0')}';
      final r = await widget.api.get('/api/by-category', query: { 'month': m });
      final json = r.data as Map<String, dynamic>;
      final data = (json['data'] as List).cast<Map<String, dynamic>>();
      _items = data.map((e) => _Cat(e['category'] as String, (e['amount'] as num).toDouble())).toList();
    } catch (e) { _error = e.toString(); }
    finally { if (mounted) setState(() { _loading = false; }); }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!, style: const TextStyle(color: Colors.red)));
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        itemCount: _items.length,
        itemBuilder: (_, i) {
          final it = _items[i];
          return ListTile(
            leading: const Icon(Icons.label_outline),
            title: Text(it.name),
            trailing: Text(it.amount.toStringAsFixed(2)),
          );
        },
      ),
    );
  }
}

class _Cat { final String name; final double amount; _Cat(this.name, this.amount); }
