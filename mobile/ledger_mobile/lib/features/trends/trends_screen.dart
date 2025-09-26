import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../src/api.dart';
import '../home/home_screen.dart' show apiProvider;

class TrendsScreen extends HookConsumerWidget {
  const TrendsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.watch(apiProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Trends')),
      body: _TrendsBody(api: api),
    );
  }
}

class _TrendsBody extends StatefulWidget {
  final ApiClient api;
  const _TrendsBody({required this.api});
  @override
  State<_TrendsBody> createState() => _TrendsBodyState();
}

class _TrendsBodyState extends State<_TrendsBody> {
  bool _loading = false;
  String? _error;
  List<String> _months = [];
  List<double> _values = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      // Use /api/monthly for current year
      final year = DateTime.now().year;
      final r = await widget.api.get('/api/monthly', query: { 'year': year });
      final json = r.data as Map<String, dynamic>;
      final data = (json['data'] as List).cast<Map<String, dynamic>>();
      _months = data.map((e) => e['month'] as String).toList();
      _values = data.map((e) => (e['amount'] as num).toDouble()).toList();
    } catch (e) {
      _error = e.toString();
    } finally {
      if (mounted) setState(() { _loading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!, style: const TextStyle(color: Colors.red)));
    if (_months.isEmpty) return const Center(child: Text('No data'));

    final spots = <FlSpot>[];
    for (var i = 0; i < _values.length; i++) {
      spots.add(FlSpot(i.toDouble(), _values[i]));
    }

    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            height: 260,
            child: LineChart(
              LineChartData(
                titlesData: FlTitlesData(
                  leftTitles: const AxisTitles(sideTitles: SideTitles(showTitles: true, reservedSize: 42)),
                  bottomTitles: AxisTitles(sideTitles: SideTitles(showTitles: true, getTitlesWidget: (v, meta) {
                    final idx = v.toInt();
                    if (idx < 0 || idx >= _months.length) return const SizedBox.shrink();
                    return Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(_months[idx].split('-').last),
                    );
                  })),
                ),
                lineBarsData: [
                  LineChartBarData(spots: spots, isCurved: true, color: Colors.indigo, dotData: const FlDotData(show: false)),
                ],
                gridData: const FlGridData(show: true),
                borderData: FlBorderData(show: true, border: Border.all(color: Colors.grey.shade300)),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              FilledButton.icon(onPressed: _load, icon: const Icon(Icons.refresh), label: const Text('Refresh')),
              const SizedBox(width: 12),
              Text('Year: ${DateTime.now().year}'),
            ],
          )
        ],
      ),
    );
  }
}
