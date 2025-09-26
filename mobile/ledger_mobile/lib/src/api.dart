import 'package:dio/dio.dart';

class ApiClient {
  final Dio _dio;
  final String baseUrl;
  final String? token;

  ApiClient({required this.baseUrl, this.token})
    : _dio = Dio(
        BaseOptions(
          baseUrl: baseUrl,
          // Give a little more headroom on first-run while emulator/NDK settle
          connectTimeout: const Duration(seconds: 20),
          receiveTimeout: const Duration(seconds: 20),
        ),
      );

  Map<String, dynamic> _headers() => {
    if (token != null && token!.isNotEmpty) 'Authorization': 'Bearer $token',
    'Accept': 'application/json',
  };

  Future<Response<T>> get<T>(String path, {Map<String, dynamic>? query}) {
    return _dio.get<T>(
      path,
      queryParameters: query,
      options: Options(headers: _headers()),
    );
  }

  Future<Response<T>> post<T>(String path, {Object? data}) {
    return _dio.post<T>(
      path,
      data: data,
      options: Options(headers: _headers()),
    );
  }
}

class SummaryResp {
  final String month;
  final num totalExpense;
  final num totalIncome;
  final int count;
  SummaryResp({
    required this.month,
    required this.totalExpense,
    required this.totalIncome,
    required this.count,
  });
  factory SummaryResp.fromJson(Map<String, dynamic> j) => SummaryResp(
    month: j['month'],
    totalExpense: j['totalExpense'] ?? 0,
    totalIncome: j['totalIncome'] ?? 0,
    count: j['count'] ?? 0,
  );
}
