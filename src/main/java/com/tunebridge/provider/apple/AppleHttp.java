package com.tunebridge.provider.apple;

import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.JdkClientHttpRequestFactory;

/**
 * Apple 要求请求带上站点来源头 Origin，而 JDK 的 HttpURLConnection 会把它当作受限头静默丢掉，
 * 所以 Apple 这条链路单独使用 java.net.http 客户端。超时与全局配置保持一致。
 */
final class AppleHttp {

    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(6);
    private static final Duration READ_TIMEOUT = Duration.ofSeconds(25);

    private AppleHttp() {
    }

    static ClientHttpRequestFactory requestFactory() {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(CONNECT_TIMEOUT)
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(client);
        factory.setReadTimeout(READ_TIMEOUT);
        return factory;
    }
}
