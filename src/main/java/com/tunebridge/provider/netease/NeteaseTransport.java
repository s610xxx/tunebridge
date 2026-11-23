package com.tunebridge.provider.netease;

import java.util.List;

/** 网易云 eapi 的传输接缝：测试用替身注入，生产走 HTTP。 */
public interface NeteaseTransport {

    Response post(String url, String formBody, String cookieHeader);

    record Response(int status, String body, List<String> setCookies) {
        public Response {
            setCookies = setCookies == null ? List.of() : List.copyOf(setCookies);
        }
    }
}
