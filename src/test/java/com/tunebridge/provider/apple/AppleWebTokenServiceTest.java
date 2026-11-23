package com.tunebridge.provider.apple;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.tunebridge.provider.ProviderException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class AppleWebTokenServiceTest {

    private static final String BASE = "https://music.apple.com";

    private static final class FakeBundles implements AppleBundleSource {
        private final String html;
        private final Map<String, String> scripts = new LinkedHashMap<>();
        private final List<String> fetched = new ArrayList<>();
        private int htmlCalls;

        FakeBundles(String html) {
            this.html = html;
        }

        @Override
        public String html() {
            htmlCalls++;
            return html;
        }

        @Override
        public String script(String url) {
            fetched.add(url);
            String body = scripts.get(url);
            if (body == null) {
                throw ProviderException.upstream("no such bundle");
            }
            return body;
        }
    }

    private static String jwt(String issuer, long expiresAt) {
        String header = encode("{\"alg\":\"ES256\",\"kid\":\"WebPlayKid\",\"typ\":\"JWT\"}");
        String payload = encode("{\"iss\":\"" + issuer + "\",\"iat\":1000,\"exp\":" + expiresAt + "}");
        return header + "." + payload + "." + encode("signature-bytes");
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static long soon() {
        return Instant.now().getEpochSecond() + 86_400;
    }

    @Test
    void picksTheWebPlayerTokenAndIgnoresOtherIssuers() {
        long exp = soon();
        String wanted = jwt("AMPWebPlay", exp);
        FakeBundles bundles = new FakeBundles("<script src=\"/assets/index~AbC.js\"></script>");
        bundles.scripts.put(BASE + "/assets/index~AbC.js",
                "var a=\"" + jwt("M62YD85FTQ", exp) + "\";var b=\"" + wanted + "\";");

        assertThat(new AppleWebTokenService(bundles).token()).isEqualTo(wanted);
        assertThat(bundles.fetched).containsExactly(BASE + "/assets/index~AbC.js");
    }

    @Test
    void cachesUntilCloseToExpiry() {
        FakeBundles bundles = new FakeBundles("<script src=\"/assets/a.js\"></script>"
                + "<script src=\"/assets/a.js\"></script>");
        bundles.scripts.put(BASE + "/assets/a.js", jwt("AMPWebPlay", Instant.now().getEpochSecond() + 30 * 86_400));
        AppleWebTokenService service = new AppleWebTokenService(bundles);

        String first = service.token();
        String second = service.token();

        assertThat(second).isEqualTo(first);
        assertThat(bundles.htmlCalls).isEqualTo(1);
    }

    @Test
    void triesBundlesInOrderUntilOneCarriesTheToken() {
        FakeBundles bundles = new FakeBundles("<script src=\"/assets/one.js\"></script>"
                + "<script src=\"/assets/two.js\"></script>");
        String second = jwt("AMPWebPlay", soon());
        bundles.scripts.put(BASE + "/assets/one.js", "无令牌");
        bundles.scripts.put(BASE + "/assets/two.js", second);

        assertThat(new AppleWebTokenService(bundles).token()).isEqualTo(second);
        assertThat(bundles.fetched).containsExactly(BASE + "/assets/one.js", BASE + "/assets/two.js");
    }

    @Test
    void ignoresWebPlayerTokensThatAreAboutToExpire() {
        FakeBundles bundles = new FakeBundles("<script src=\"/assets/a.js\"></script>");
        bundles.scripts.put(BASE + "/assets/a.js", jwt("AMPWebPlay", Instant.now().getEpochSecond() + 60));

        assertThatThrownBy(new AppleWebTokenService(bundles)::token)
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("Apple Music 网页版");
    }

    @Test
    void reportsAFriendlyErrorWhenThePageLayoutChanged() {
        assertThatThrownBy(new AppleWebTokenService(new FakeBundles("<html>没有脚本</html>"))::token)
                .isInstanceOf(ProviderException.class)
                .satisfies(ex -> assertThat(((ProviderException) ex).code()).isEqualTo("UPSTREAM_ERROR"));
    }

    @Test
    void capsHowManyBundlesItDownloads() {
        StringBuilder html = new StringBuilder();
        for (int i = 0; i < 9; i++) {
            html.append("<script src=\"/assets/").append(i).append(".js\"></script>");
        }
        assertThat(AppleWebTokenService.scriptUrls(html.toString())).hasSize(4)
                .allSatisfy(url -> assertThat(url).startsWith(BASE + "/assets/"));
    }

    @Test
    void parsesOnlyWellFormedCompactTokens() {
        long now = Instant.now().getEpochSecond();
        String token = jwt("AMPWebPlay", now + 86_400);

        assertThat(AppleWebTokenService.webToken("var x=\"" + token + "\";", now)).isNotNull();
        assertThat(AppleWebTokenService.webToken(token.replace(".", ""), now)).isNull();
        assertThat(AppleWebTokenService.webToken("eyJhbGciOiJFUzI1NiJ9.not-a-segment", now)).isNull();
        assertThat(AppleWebTokenService.webToken(null, now)).isNull();
    }
}
