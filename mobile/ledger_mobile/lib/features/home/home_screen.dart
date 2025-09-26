import 'package:flutter/material.dart';
import 'package:dio/dio.dart' as dio;
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../src/api.dart';
import '../../src/state.dart';

final apiProvider = Provider<ApiClient>((ref) {
  const base = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:8090');
  const token = String.fromEnvironment('API_TOKEN', defaultValue: '');
  return ApiClient(baseUrl: base, token: token);
});

class HomeScreen extends HookConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.watch(apiProvider);
    final month = ref.watch(monthProvider);
    final loading = useState(false);
    final summary = useState<SummaryResp?>(null);
    final error = useState<String?>(null);
    final categories = useState<List<Map<String, dynamic>>>(const []);
    final recent = useState<List<Map<String, dynamic>>>(const []);

    String ym(DateTime d) => '${d.year}-${d.month.toString().padLeft(2,'0')}';

    Future<void> load() async {
      loading.value = true; error.value = null;
      try {
        final r = await api.get('/api/summary', query: {'month': ym(month)});
        summary.value = SummaryResp.fromJson(r.data as Map<String, dynamic>);
        final bc = await api.get('/api/by-category', query: {'month': ym(month)});
        categories.value = List<Map<String,dynamic>>.from((bc.data as Map<String,dynamic>)['data'] as List);
        final ent = await api.get('/api/entries', query: {'month': ym(month), 'limit': 10});
        recent.value = List<Map<String,dynamic>>.from((ent.data as Map<String,dynamic>)['data'] as List);
      } catch (e) { error.value = e.toString(); }
      finally { loading.value = false; }
    }

    useEffect(() { load(); return null; }, [month]);

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
                OutlinedButton.icon(
                  icon: const Icon(Icons.calendar_today_outlined),
                  label: Text(ym(month)),
                  onPressed: () async {
                    final picked = await _pickMonthYear(context, month);
                    if (picked != null) {
                      ref.read(monthProvider.notifier).state = picked;
                    }
                  },
                ),
                Row(children: [
                  IconButton(onPressed: (){ ref.read(monthProvider.notifier).state = DateTime.utc(month.year, month.month-1, 1); }, icon: const Icon(Icons.chevron_left)),
                  IconButton(onPressed: (){ ref.read(monthProvider.notifier).state = DateTime.utc(month.year, month.month+1, 1); }, icon: const Icon(Icons.chevron_right)),
                ])
              ],
            ),
            const SizedBox(height: 12),
            if (loading.value) const LinearProgressIndicator(),
            if (error.value != null) Text(error.value!, style: const TextStyle(color: Colors.red)),
            if (summary.value != null) _SummaryCards(s: summary.value!),
            const SizedBox(height: 16),
            _TopCategories(categories: categories.value),
            const SizedBox(height: 16),
            _RecentEntries(items: recent.value),
            const SizedBox(height: 24),
            FilledButton.icon(onPressed: () => _showQuickAdd(context, api, load), icon: const Icon(Icons.add), label: const Text('Quick add')),
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
    return Row(children: [
      Expanded(child: _Card(label: 'Out', value: s.totalExpense.toStringAsFixed(2))),
      const SizedBox(width: 12),
      Expanded(child: _Card(label: 'In', value: s.totalIncome.toStringAsFixed(2))),
      const SizedBox(width: 12),
      Expanded(child: _Card(label: 'Count', value: s.count.toString())),
    ]);
  }
}

class _Card extends StatelessWidget {
  final String label; final String value; const _Card({required this.label, required this.value});
  @override
  Widget build(BuildContext context) {
    return Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: Theme.of(context).textTheme.labelMedium),
      const SizedBox(height: 8),
      Text(value, style: Theme.of(context).textTheme.headlineSmall),
    ])));
  }
}

class _TopCategories extends StatelessWidget {
  final List<Map<String, dynamic>> categories;
  const _TopCategories({required this.categories});
  @override
  Widget build(BuildContext context) {
    if (categories.isEmpty) return const SizedBox.shrink();
    final top = [...categories]..sort((a,b)=> (b['amount'] as num).compareTo(a['amount'] as num));
    final display = top.take(5).toList();
    final other = top.skip(5).fold<num>(0, (s,e)=> s + (e['amount'] as num));
    final items = [ ...display, if (other>0) { 'category':'other', 'amount': other } ];
    final total = items.fold<num>(0, (s,e)=> s + (e['amount'] as num));

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Top categories', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 12),
          Wrap(spacing: 12, runSpacing: 8, children: [
            for (final it in items)
              Chip(label: Text('${it['category']}: ${(it['amount'] as num).toStringAsFixed(2)}')),
          ]),
          const SizedBox(height: 8),
          Text('Total: ${total.toStringAsFixed(2)}'),
        ]),
      ),
    );
  }
}

class _RecentEntries extends StatelessWidget {
  final List<Map<String, dynamic>> items; const _RecentEntries({required this.items});
  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.all(8.0), child: Text('Recent', style: Theme.of(context).textTheme.titleMedium)),
          ...items.map((e) => ListTile(
            dense: true,
            title: Text(e['description'] ?? ''),
            subtitle: Text('${e['createdAt'] ?? e['created_at'] ?? ''} · ${e['code'] ?? ''} · cat: ${_fmtCat(_catFromEntry(e))}'),
            trailing: Text('${(e['amount'] as num?)?.toStringAsFixed(2) ?? '0.00'} ${e['currency'] ?? ''}'),
          )),
        ]),
      ),
    );
  }
}

String _catFromDesc(dynamic desc) {
  final s = (desc is String ? desc : '').trim();
  if (s.isEmpty) return 'uncategorized';
  return s.split(RegExp(r"\s+")).first.toLowerCase();
}

String _fmtCat(String cat) {
  if (cat.length == 1) return cat.toUpperCase();
  return cat;
}

String _catFromEntry(Map e) {
  final code = (e['code'] ?? '').toString().trim().toLowerCase();
  const known = {'g','f','t','b','h','r','m','u'};
  if (known.contains(code)) return code;
  return _catFromDesc(e['description']);
}

Future<void> _showQuickAdd(BuildContext context, ApiClient api, Future<void> Function() reload) async {
  final formKey = GlobalKey<FormState>();
  final amountCtrl = TextEditingController();
  final descCtrl = TextEditingController();
  String currency = 'JOD';
  String category = 'g';
  bool saving = false;

  await showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (ctx) {
      return StatefulBuilder(builder: (ctx, setState) {
        return Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Form(
              key: formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Quick add', style: Theme.of(ctx).textTheme.titleMedium),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: amountCtrl,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(labelText: 'Amount'),
                    validator: (v) => (v==null||v.isEmpty) ? 'Required' : null,
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    initialValue: category,
                    items: const [
                      DropdownMenuItem(value: 'g', child: Text('Groceries (G)')),
                      DropdownMenuItem(value: 'f', child: Text('Food (F)')),
                      DropdownMenuItem(value: 't', child: Text('Transport (T)')),
                      DropdownMenuItem(value: 'b', child: Text('Bills (B)')),
                      DropdownMenuItem(value: 'h', child: Text('Health (H)')),
                      DropdownMenuItem(value: 'r', child: Text('Rent (R)')),
                      DropdownMenuItem(value: 'm', child: Text('Misc (M)')),
                      DropdownMenuItem(value: 'u', child: Text('Uncategorized (U)')),
                    ],
                    onChanged: (v) => setState(() => category = v ?? 'g'),
                    decoration: const InputDecoration(labelText: 'Category'),
                  ),
                  const SizedBox(height: 8),
                  TextFormField(
                    controller: descCtrl,
                    decoration: const InputDecoration(labelText: 'Description'),
                    validator: (v) => (v==null||v.isEmpty) ? 'Required' : null,
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    initialValue: currency,
                    items: const [ 'JOD','USD','EUR','SAR' ]
                      .map((c) => DropdownMenuItem(value: c, child: Text(c))).toList(),
                    onChanged: (v) => setState(() => currency = v ?? 'JOD'),
                    decoration: const InputDecoration(labelText: 'Currency'),
                  ),
                  const SizedBox(height: 16),
                  Row(children: [
                    Expanded(child: FilledButton.icon(
                      onPressed: saving ? null : () async {
                        if (!formKey.currentState!.validate()) return;
                        setState(() => saving = true);
                        try {
                          await api.post('/api/mobile/entry', data: {
                            'chatId': 'mobile',
                            'code': category.toUpperCase(),
                            'amount': double.tryParse(amountCtrl.text) ?? 0,
                            'currency': currency,
                            'description': descCtrl.text.trim(),
                          });
                          if (context.mounted) {
                            Navigator.of(ctx).pop();
                            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Saved')));
                            await reload();
                          }
                        } catch (e) {
                          setState(() => saving = false);
                          if (context.mounted) {
                            String msg = 'Failed';
                            if (e is dio.DioException) {
                              final data = e.response?.data;
                              if (data is Map && data['error'] != null) {
                                msg = 'Failed: ${data['error']}';
                              } else if (e.message != null) {
                                msg = 'Failed: ${e.message}';
                              }
                            } else {
                              msg = 'Failed: $e';
                            }
                            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
                          }
                        }
                      }, icon: const Icon(Icons.save), label: Text(saving ? 'Saving...' : 'Save'),
                    )),
                  ])
                ],
              ),
            ),
          ),
        );
      });
    },
  );
}

Future<DateTime?> _pickMonthYear(BuildContext context, DateTime initial) async {
  int year = initial.year;
  int month = initial.month;
  bool editingYear = false;
  final yearCtrl = TextEditingController(text: initial.year.toString());
  final yearFocus = FocusNode();
  return showDialog<DateTime>(
    context: context,
    builder: (ctx) {
      return StatefulBuilder(builder: (ctx, setState) {
        return SimpleDialog(
          title: const Text('Select month and year'),
          contentPadding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                IconButton(
                  tooltip: 'Prev year',
                  onPressed: () => setState(() => year -= 1),
                  icon: const Icon(Icons.chevron_left),
                ),
                GestureDetector(
                  onTap: () {
                    setState(() {
                      editingYear = true;
                      yearCtrl.text = year.toString();
                    });
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (yearFocus.canRequestFocus) yearFocus.requestFocus();
                    });
                  },
                  child: editingYear
                      ? SizedBox(
                          width: 96,
                          child: TextField(
                            controller: yearCtrl,
                            focusNode: yearFocus,
                            autofocus: true,
                            textAlign: TextAlign.center,
                            keyboardType: const TextInputType.numberWithOptions(signed: false, decimal: false),
                            decoration: const InputDecoration(isDense: true, contentPadding: EdgeInsets.symmetric(vertical: 6, horizontal: 8)),
                            onSubmitted: (v) {
                              final val = int.tryParse(v.trim());
                              if (val != null && val > 0) {
                                setState(() { year = val; editingYear = false; });
                              } else {
                                setState(() { editingYear = false; });
                              }
                            },
                          ),
                        )
                      : Text('$year', style: Theme.of(ctx).textTheme.titleLarge),
                ),
                IconButton(
                  tooltip: 'Next year',
                  onPressed: () => setState(() => year += 1),
                  icon: const Icon(Icons.chevron_right),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: List.generate(12, (i) {
                final m = i + 1;
                final selected = m == month;
                return ChoiceChip(
                  label: Text(m.toString().padLeft(2, '0')),
                  selected: selected,
                  onSelected: (_) => setState(() => month = m),
                );
              }),
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Cancel')),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: () => Navigator.of(ctx).pop(DateTime.utc(year, month, 1)),
                  child: const Text('Select'),
                ),
              ],
            )
          ],
        );
      });
    },
  );
}
