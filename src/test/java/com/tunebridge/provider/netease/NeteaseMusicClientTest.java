package com.tunebridge.provider.netease;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.ProviderException;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class NeteaseMusicClientTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void mapsSearchAndKeepsUntrustedValuesInSingleArguments() {
        List<List<String>> calls = new ArrayList<>();
        NeteaseMusicClient client = new NeteaseMusicClient(mapper, args -> {
            calls.add(args);
            return "{\"code\":200,\"data\":{\"records\":[{\"id\":\"enc+/=\",\"name\":\"歌\",\"artists\":[{\"name\":\"甲\"},{\"name\":\"乙\"}],\"album\":{\"name\":\"专辑\"},\"duration\":123456,\"coverImgUrl\":\"https://cover\"}]}}";
        });
        Track track = client.searchTracks("--output=json \"歌\"", "中文 歌手", 5).get(0);
        assertEquals(new Track("enc+/=", "歌", "甲 / 乙", "专辑", 123, "https://cover", 0), track);
        assertEquals("--keyword=--output=json \"歌\" 中文 歌手", calls.get(0).get(2));
        assertEquals(5, calls.get(0).size());
        assertThrows(ProviderException.class, () -> client.searchTracks("x\ny", "", 1));
    }

    @Test
    void createsWithNullNameAndPreservesInjectedTextAsOneArgument() {
        List<List<String>> calls = new ArrayList<>();
        NeteaseMusicClient client = new NeteaseMusicClient(mapper, args -> {
            calls.add(args);
            return "{\"code\":200,\"data\":{\"id\":\"abc+/=\",\"originalId\":12345,\"name\":null}}";
        });
        CreatedPlaylist created = client.createPlaylist("中文 \"--output=x\"");
        assertEquals("中文 \"--output=x\"", created.name());
        assertEquals("abc+/=", created.id());
        assertEquals("https://music.163.com/#/playlist?id=12345", created.url());
        assertEquals("--playlistName=中文 \"--output=x\"", calls.get(0).get(2));
        assertThrows(ProviderException.class, () -> client.createPlaylist("bad\u0000name"));
    }

    @Test
    void verifiesMultipleShortPagesAndIgnoresAddDataMeaning() {
        List<List<String>> calls = new ArrayList<>();
        NeteaseMusicClient client = new NeteaseMusicClient(mapper, args -> {
            calls.add(args);
            if (args.get(1).equals("add")) return "{\"code\":200,\"data\":[\"unknown\"]}";
            if (args.contains("--offset=0")) return "{\"code\":200,\"data\":[{\"id\":\"a\"}]}";
            if (args.contains("--offset=1")) return "{\"code\":200,\"data\":[{\"id\":\"b\"}]}";
            return "{\"code\":200,\"data\":[]}";
        });
        client.addTracks(CreatedPlaylist.of("p", "x", "", 0), tracks("a", "b"));
        assertEquals("--songIdList=[\"a\",\"b\"]", calls.get(0).get(3));
        assertEquals(4, calls.size());
    }

    @Test
    void rejectsOmissionsDuplicatesAndReordering() {
        for (String page : List.of("[{\"id\":\"a\"}]", "[{\"id\":\"a\"},{\"id\":\"a\"}]", "[{\"id\":\"b\"},{\"id\":\"a\"}]")) {
            NeteaseMusicClient client = new NeteaseMusicClient(mapper, args -> {
                if (args.get(1).equals("add")) return "{\"code\":200,\"data\":[]}";
                return "{\"code\":200,\"data\":" + (args.contains("--offset=0") ? page : "[]") + "}";
            });
            ProviderException ex = assertThrows(ProviderException.class,
                    () -> client.addTracks(CreatedPlaylist.of("p", "x", "", 0), tracks("a", "b")));
            assertTrue(ex.getMessage().contains("未验证"));
        }
    }

    @Test
    void neverRetriesWriteOrCreateOnTimeoutAndDoesNotLeakOutput() {
        int[] calls = {0};
        NeteaseMusicClient client = new NeteaseMusicClient(mapper, args -> {
            calls[0]++;
            throw ProviderException.upstream("secret stdout");
        });
        ProviderException write = assertThrows(ProviderException.class,
                () -> client.addTracks(CreatedPlaylist.of("p", "x", "", 0), tracks("a")));
        assertTrue(write.getMessage().contains("检查目标歌单"));
        assertFalse(write.getMessage().contains("secret"));
        assertEquals(1, calls[0]);
        ProviderException create = assertThrows(ProviderException.class, () -> client.createPlaylist("name"));
        assertTrue(create.getMessage().contains("检查目标歌单"));
        assertFalse(create.getMessage().contains("secret"));
        assertEquals(2, calls[0]);
    }

    @Test
    void verifiesEveryBatchAndRejectsDuplicateExpectedIdsBeforeWriting() {
        List<List<String>> calls = new ArrayList<>();
        List<String> written = new ArrayList<>();
        NeteaseMusicClient client = new NeteaseMusicClient(mapper, args -> {
            calls.add(args);
            try {
                if (args.get(1).equals("add")) {
                    mapper.readTree(args.get(3).substring("--songIdList=".length()))
                            .forEach(id -> written.add(id.asText()));
                    return "{\"code\":200,\"data\":[]}";
                }
                int offset = Integer.parseInt(args.get(4).substring("--offset=".length()));
                var page = mapper.createArrayNode();
                written.stream().skip(offset).limit(50).forEach(id -> page.addObject().put("id", id));
                return mapper.createObjectNode().put("code", 200).set("data", page).toString();
            } catch (Exception ex) {
                throw new IllegalStateException();
            }
        });
        List<Track> tracks = java.util.stream.IntStream.range(0, 51)
                .mapToObj(i -> Track.of("id" + i, "t", "a", "", 1)).toList();
        client.addTracks(CreatedPlaylist.of("p", "x", "", 0), tracks);
        assertEquals(2, calls.stream().filter(c -> c.get(1).equals("add")).count());
        assertEquals(51, written.size());
        int before = calls.size();
        assertThrows(ProviderException.class, () -> client.addTracks(
                CreatedPlaylist.of("p", "x", "", 0), tracks("a", "a")));
        assertEquals(before, calls.size());
    }

    @Test
    void sanitizesSearchFailureAndRejectsInvalidTokens() {
        NeteaseMusicClient client = new NeteaseMusicClient(mapper, args -> {
            throw ProviderException.upstream("private cli output");
        });
        assertFalse(assertThrows(ProviderException.class, () -> client.searchTracks("x", "", 1))
                .getMessage().contains("private"));
        assertThrows(ProviderException.class, () -> client.addTracks(
                CreatedPlaylist.of("--bad", "x", "", 0), tracks("a\n")));
    }

    @Test
    void preservesFatalStatusWithoutExposingExecutorMessages() {
        for (ProviderException failure : List.of(ProviderException.notConfigured("private config"),
                ProviderException.rateLimited("private output"), ProviderException.unauthorized("private account"))) {
            NeteaseMusicClient client = new NeteaseMusicClient(mapper, args -> { throw failure; });
            ProviderException actual = assertThrows(ProviderException.class, () -> client.searchTracks("x", "", 1));
            assertEquals(failure.status(), actual.status());
            assertEquals(failure.code(), actual.code());
            assertFalse(actual.getMessage().contains("private"));
        }
    }

    private static List<Track> tracks(String... ids) {
        return java.util.Arrays.stream(ids).map(id -> Track.of(id, "t", "a", "", 1)).toList();
    }
}
