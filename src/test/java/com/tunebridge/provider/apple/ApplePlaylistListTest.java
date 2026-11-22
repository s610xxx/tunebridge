package com.tunebridge.provider.apple;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.PlaylistRef;
import java.util.List;
import org.junit.jupiter.api.Test;

class ApplePlaylistListTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void keepsLibraryPlaylistsAndBuildsALibraryUrlWhenAppleOmitsOne() throws Exception {
        JsonNode data = mapper.readTree("""
                [
                  {"id": "p.7QNmvBpqnAaX42", "attributes": {"name": "通勤爵士"}},
                  {"id": "p.legacy", "attributes": {"name": "带链接的歌单",
                    "url": "https://music.apple.com/us/playlist/x/pl.legacy",
                    "artwork": {"url": "https://a/100x100bb.jpg/{w}x{h}"}}},
                  {"id": "pl.5ee8333dbe944d9f9151e97d92b35eaa", "attributes": {"name": "不是资料库歌单"}}
                ]
                """);

        List<PlaylistRef> refs = AppleMusicClient.parseLibraryPlaylists(data, "us", 50);

        assertThat(refs).hasSize(2);
        assertThat(refs.get(0).id()).isEqualTo("p.7QNmvBpqnAaX42");
        assertThat(refs.get(0).name()).isEqualTo("通勤爵士");
        assertThat(refs.get(0).url()).isEqualTo("https://music.apple.com/us/library/playlist/p.7QNmvBpqnAaX42");
        assertThat(refs.get(0).trackCount()).isZero();
        assertThat(refs.get(1).url()).isEqualTo("https://music.apple.com/us/playlist/x/pl.legacy");
        assertThat(refs.get(1).coverUrl()).isEqualTo("https://a/100x100bb.jpg/300x300");
    }

    @Test
    void namesUnnamedPlaylistsAndRespectsTheLimit() throws Exception {
        List<PlaylistRef> refs = AppleMusicClient.parseLibraryPlaylists(mapper.readTree("""
                [
                  {"id": "p.one", "attributes": {}},
                  {"id": "p.two", "attributes": {"name": "  "}},
                  {"id": "p.three", "attributes": {"name": "第三份"}}
                ]
                """), "cn", 2);

        assertThat(refs).hasSize(2);
        assertThat(refs.get(0).name()).isEqualTo("Apple Music 歌单");
        assertThat(refs.get(0).url()).startsWith("https://music.apple.com/cn/library/playlist/");
        assertThat(refs.get(1).name()).isEqualTo("Apple Music 歌单");
    }

    @Test
    void skipsEntriesWithoutALibraryId() throws Exception {
        assertThat(AppleMusicClient.parseLibraryPlaylists(mapper.readTree("""
                [{"attributes": {"name": "缺 ID"}}, {"id": "", "attributes": {"name": "空 ID"}}]
                """), "us", 10)).isEmpty();
    }
}
