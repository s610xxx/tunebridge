package com.tunebridge.provider.netease;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.netease.NeteaseWebClient.QrStatus;
import java.util.List;
import org.junit.jupiter.api.Test;

class NeteaseWebClientTest {

    private final Recorder recorder = new Recorder();
    private final NeteaseWebClient client = new NeteaseWebClient(recorder, new ObjectMapper());

    @Test
    void sendsTheQrKeyRequestToTheEapiChannelWithEncryptedParams() {
        recorder.reply = new NeteaseTransport.Response(200, "{\"unikey\":\"uk-1\",\"code\":200}", List.of());

        NeteaseWebClient.QrKeyResult result = client.requestQrKey();

        assertThat(result.unikey()).isEqualTo("uk-1");
        assertThat(recorder.url).isEqualTo("https://music.163.com/eapi/login/qrcode/unikey");
        assertThat(recorder.body).matches("params=[0-9A-F]+");
        assertThat(recorder.cookie).isNull();
    }

    @Test
    void failsWhenTheQrKeyIsMissing() {
        recorder.reply = new NeteaseTransport.Response(200, "{\"code\":200}", List.of());

        assertThatThrownBy(() -> client.requestQrKey())
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("二维码密钥");
    }

    @Test
    void keepsOnlyTheLoginCookiesWhenTheScanIsConfirmed() {
        recorder.reply = new NeteaseTransport.Response(200, "{\"code\":803,\"message\":\"ok\"}", List.of(
                "MUSIC_U=token; Max-Age=31536000; Path=/",
                "NMTID=abc; Path=/; HttpOnly",
                "server_netsp=1; Path=/"));

        QrStatus status = client.pollQr("uk-1", null);

        assertThat(status.code()).isEqualTo(803);
        assertThat(status.cookie()).isEqualTo("MUSIC_U=token; NMTID=abc");
        assertThat(recorder.url).isEqualTo("https://music.163.com/eapi/login/qrcode/client/login");
    }

    @Test
    void refusesToReportAnAccountWithoutLoginState() {
        recorder.reply = new NeteaseTransport.Response(200, "{\"account\":null,\"code\":200}", List.of());

        assertThatThrownBy(() -> client.accountName("MUSIC_U=expired"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("重新扫码");
        assertThat(recorder.cookie).isEqualTo("MUSIC_U=expired");
    }

    @Test
    void surfacesAnUpstreamErrorWhenTheTransportFails() {
        recorder.failure = new org.springframework.web.client.ResourceAccessException("timeout");

        assertThatThrownBy(() -> client.requestQrKey())
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("稍后重试");
    }

    @Test
    void sendsCookiesToThePollEndpointWhenProvided() {
        recorder.reply = new NeteaseTransport.Response(200, "{\"code\":801,\"message\":\"等待扫码\"}", List.of());

        QrStatus status = client.pollQr("uk-1", "MUSIC_U=token; NMTID=abc");

        assertThat(status.code()).isEqualTo(801);
        assertThat(recorder.cookie).isEqualTo("MUSIC_U=token; NMTID=abc");
    }

    @Test
    void dropsOnlySongsThePlatformMarksAsDelisted() {
        recorder.reply = new NeteaseTransport.Response(200, """
                {"result":{"songs":[
                  {"id":"3","name":"已下架","privilege":{"st":-200}},
                  {"id":"4","name":"正常","artists":[{"name":"G.E.M."}]},
                  {"id":"5","name":"会员曲","fee":1,"privilege":{"st":0}}
                ]}}""", List.of());

        List<Track> tracks = client.searchTracks("MUSIC_U=t", "天空没有极限", "G.E.M.", 10);

        assertThat(tracks).extracting(Track::providerTrackId).containsExactly("4", "5");
    }

    @Test
    void keepsSongsWhenTheResponseCarriesNoPlayabilitySignals() {
        recorder.reply = new NeteaseTransport.Response(200,
                "{\"result\":{\"songs\":[{\"id\":\"9\",\"name\":\"无字段\"}]}}", List.of());

        assertThat(client.searchTracks("MUSIC_U=t", "无字段", "", 10))
                .extracting(Track::providerTrackId).containsExactly("9");
    }

    @Test
    void readsSongDetailStyleFieldNamesAsWellAsCloudsearchOnes() {
        recorder.reply = new NeteaseTransport.Response(200, """
                {"result":{"songs":[
                  {"id":"7","name":"泡沫","ar":[{"name":"G.E.M.邓紫棋"}],"al":{"name":"Xposed","picUrl":"p.jpg"},"dt":262000}
                ]}}""", List.of());

        Track track = client.searchTracks("MUSIC_U=t", "泡沫", "G.E.M.", 6).get(0);

        assertThat(track.artist()).isEqualTo("G.E.M.邓紫棋");
        assertThat(track.album()).isEqualTo("Xposed");
        assertThat(track.durationSec()).isEqualTo(262);
        assertThat(track.artworkUrl()).isEqualTo("p.jpg");
    }

    @Test
    void retriesThrottledSearchAndUsesTheResultThatFollows() {
        client.searchRetryDelays = new long[]{0, 0};
        recorder.queued.add(new NeteaseTransport.Response(200,
                "{\"header\":{\"code\":\"405\",\"msg\":\"操作频繁，请稍候再试\"}}", List.of()));
        recorder.queued.add(new NeteaseTransport.Response(200,
                "{\"result\":{\"songs\":[{\"id\":\"8\",\"name\":\"泡沫\",\"ar\":[{\"name\":\"G.E.M.邓紫棋\"}]}]}}",
                List.of()));

        assertThat(client.searchTracks("MUSIC_U=t", "泡沫", "G.E.M.", 6))
                .extracting(Track::providerTrackId).containsExactly("8");
        assertThat(recorder.queued).isEmpty();
    }

    @Test
    void callsPersistentThrottlingThrottledInsteadOfNoMatch() {
        client.searchRetryDelays = new long[]{0, 0};
        for (int i = 0; i < 3; i++) {
            recorder.queued.add(new NeteaseTransport.Response(200,
                    "{\"header\":{\"code\":\"405\",\"msg\":\"操作频繁，请稍候再试\"}}", List.of()));
        }

        assertThatThrownBy(() -> client.searchTracks("MUSIC_U=t", "泡沫", "G.E.M.", 6))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("被限流")
                .hasMessageContaining("405");
    }

    @Test
    void readsTheCsrfTokenThatWriteEndpointsRequire() {
        assertThat(NeteaseWebClient.csrfToken("MUSIC_U=t; __csrf=ab12; NMTID=x")).isEqualTo("ab12");
        assertThat(NeteaseWebClient.csrfToken("MUSIC_U=t")).isEmpty();
        assertThat(NeteaseWebClient.csrfToken(null)).isEmpty();
    }

    @Test
    void pointsAtTheMissingCsrfCookieWhenPlaylistCreateIsRejected() {
        recorder.reply = new NeteaseTransport.Response(200,
                "{\"code\":403,\"header\":{\"code\":\"403\",\"msg\":\"illegal request!\"}}", List.of());

        assertThatThrownBy(() -> client.createPlaylist("MUSIC_U=t", "新歌单"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("业务码 403：illegal request!")
                .hasMessageContaining("缺少 __csrf");
    }

    @Test
    void signsTheApiPathEvenThoughTheRequestUsesTheEapiChannel() {
        String body = NeteaseEapi.formBody("/api/nuser/account/get", NeteaseEapi.params());

        assertThat(body).startsWith("params=").doesNotContain("/api/nuser/account/get");
        assertThat(body.substring("params=".length())).matches("[0-9A-F]+");
        assertThat(NeteaseEapi.params()).containsKeys("os", "appver", "deviceId", "csrf_token");
    }

    private static final class Recorder implements NeteaseTransport {
        private String url;
        private String body;
        private String cookie;
        private final java.util.Deque<NeteaseTransport.Response> queued = new java.util.ArrayDeque<>();
        private NeteaseTransport.Response reply = new NeteaseTransport.Response(200, "{}", List.of());
        private RuntimeException failure;

        @Override
        public Response post(String requestUrl, String formBody, String cookieHeader) {
            this.url = requestUrl;
            this.body = formBody;
            this.cookie = cookieHeader;
            if (failure != null) {
                throw failure;
            }
            return queued.isEmpty() ? reply : queued.poll();
        }
    }
}
