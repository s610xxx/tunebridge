package com.tunebridge.provider.apple;

import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.provider.ProviderException;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

@Component
public class HttpAppleBundles implements AppleBundleSource {

    private static final String WEB_PLAYER_BASE = "https://music.apple.com";
    private static final String BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    private final RestClient restClient;
    private final String entryUrl;

    public HttpAppleBundles(TuneBridgeProperties properties) {
        this.restClient = RestClient.builder().requestFactory(AppleHttp.requestFactory()).build();
        this.entryUrl = WEB_PLAYER_BASE + "/" + storefront(properties);
    }

    @Override
    public String html() {
        return body(restClient.get().uri(entryUrl)
                .header(HttpHeaders.USER_AGENT, BROWSER_USER_AGENT)
                .header(HttpHeaders.ACCEPT_LANGUAGE, "en-US,en;q=0.9"));
    }

    @Override
    public String script(String url) {
        return body(restClient.get().uri(url).header(HttpHeaders.USER_AGENT, BROWSER_USER_AGENT));
    }

    private static String body(RestClient.RequestHeadersSpec<?> spec) {
        try {
            String value = spec.retrieve().body(String.class);
            if (value == null || value.isBlank()) {
                throw ProviderException.upstream("Apple Music 网页版返回了空页面");
            }
            return value;
        } catch (RestClientException ex) {
            throw ProviderException.upstream("Apple Music 网页版暂时无法访问");
        }
    }

    private static String storefront(TuneBridgeProperties properties) {
        String value = properties.getApple().getDefaultStorefront();
        return value != null && value.matches("[A-Za-z]{2,3}") ? value.toLowerCase() : "us";
    }
}
