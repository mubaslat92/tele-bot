import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../features/home/home_screen.dart';
import '../features/trends/trends_screen.dart';
import '../features/categories/categories_screen.dart';
import '../features/entries/entries_screen.dart';

class LedgerApp extends ConsumerWidget {
  const LedgerApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = GoRouter(
      routes: [
        ShellRoute(
          builder: (context, state, child) => _RootShell(child: child),
          routes: [
            GoRoute(path: '/', name: 'home', builder: (_, __) => const HomeScreen()),
            GoRoute(path: '/trends', name: 'trends', builder: (_, __) => const TrendsScreen()),
            GoRoute(path: '/categories', name: 'categories', builder: (_, __) => const CategoriesScreen()),
            GoRoute(path: '/entries', name: 'entries', builder: (_, __) => const EntriesScreen()),
          ],
        ),
      ],
    );

    return MaterialApp.router(
      title: 'Ledger',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
      ),
      routerConfig: router,
    );
  }
}

class _RootShell extends StatefulWidget {
  final Widget child;
  const _RootShell({required this.child});

  @override
  State<_RootShell> createState() => _RootShellState();
}

class _RootShellState extends State<_RootShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final loc = GoRouterState.of(context).uri.toString();
    if (loc.startsWith('/trends')) {
      _index = 1;
    } else if (loc.startsWith('/categories')) {
      _index = 2;
    } else if (loc.startsWith('/entries')) {
      _index = 3;
    } else {
      _index = 0;
    }

    return Scaffold(
      body: widget.child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) {
          if (i == 0) {
            context.go('/');
          } else if (i == 1) {
            context.go('/trends');
          } else if (i == 2) {
            context.go('/categories');
          } else {
            context.go('/entries');
          }
          setState(() => _index = i);
        },
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.show_chart_outlined), selectedIcon: Icon(Icons.show_chart), label: 'Trends'),
          NavigationDestination(icon: Icon(Icons.category_outlined), selectedIcon: Icon(Icons.category), label: 'Categories'),
          NavigationDestination(icon: Icon(Icons.list_alt_outlined), selectedIcon: Icon(Icons.list_alt), label: 'Entries'),
        ],
      ),
    );
  }
}
