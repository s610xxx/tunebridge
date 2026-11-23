package com.tunebridge.provider.netease;

import java.util.List;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class HttpNeteaseTransport implements NeteaseTransport {
    private static final String USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    private final RestClient restClient;

    public HttpNeteaseTransport(ClientHttpRequestFactory requestFactory) {
        this.restClient = RestClient.builder().requestFactory(requestFactory).build();
    }

    @Override
    public Response post(String url, String formBody, String cookieHeader) {
        ResponseEntity<String> entity = restClient.post()
                .uri(url)
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .header(HttpHeaders.USER_AGENT, USER_AGENT)
                .header(HttpHeaders.REFERER, "https://music.163.com/")
                .header(HttpHeaders.ORIGIN, "https://music.163.com")
                .headers(headers -> {
                    if (cookieHeader != null && !cookieHeader.isBlank()) {
                        headers.set(HttpHeaders.COOKIE, cookieHeader);
                    }
                })
                .body(formBody)
                .retrieve()
                .toEntity(String.class);
        List<String> cookies = entity.getHeaders().get(HttpHeaders.SET_COOKIE);
        return new Response(entity.getStatusCode().value(), entity.getBody(), cookies);
    }
}
