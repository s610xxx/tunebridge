package com.tunebridge.provider.apple;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.tunebridge.provider.ProviderException;
import org.junit.jupiter.api.Test;

class AppleUrlParserTest {

    @Test
    void acceptsRawCatalogId() {
        AppleUrlParser.ApplePlaylistRef ref = AppleUrlParser.parse("pl.5ee8333dbe944d9f9151e97d92b35eaa");

        assertThat(ref.id()).isEqualTo("pl.5ee8333dbe944d9f9151e97d92b35eaa");
        assertThat(ref.library()).isFalse();
    }

    @Test
    void acceptsLibraryIdsWithDotsAndHyphens() {
        AppleUrlParser.ApplePlaylistRef ref = AppleUrlParser.parse("p.u-1234.abcdef");

        assertThat(ref.id()).isEqualTo("p.u-1234.abcdef");
        assertThat(ref.library()).isTrue();
    }

    @Test
    void readsIdFromShareLink() {
        AppleUrlParser.ApplePlaylistRef ref = AppleUrlParser.parse(
                "https://music.apple.com/us/playlist/a-list-pop/pl.5ee8333dbe944d9f9151e97d92b35eaa?l=en");

        assertThat(ref.id()).isEqualTo("pl.5ee8333dbe944d9f9151e97d92b35eaa");
        assertThat(ref.library()).isFalse();
    }

    @Test
    void rejectsAlbumLinks() {
        assertThatThrownBy(() -> AppleUrlParser.parse("https://music.apple.com/us/album/midnights/1649439386"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("专辑链接");
    }

    @Test
    void rejectsForeignHost() {
        assertThatThrownBy(() -> AppleUrlParser.parse("https://example.com/us/playlist/x/pl.abc"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("不是 Apple Music 链接");
    }

    @Test
    void rejectsLinkWithoutPlaylistId() {
        assertThatThrownBy(() -> AppleUrlParser.parse("https://music.apple.com/us/browse"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("没有找到 Apple Music 歌单 ID");
    }
}
