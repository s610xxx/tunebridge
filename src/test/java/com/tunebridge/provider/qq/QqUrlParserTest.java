package com.tunebridge.provider.qq;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.tunebridge.provider.ProviderException;
import org.junit.jupiter.api.Test;

class QqUrlParserTest {

    @Test
    void acceptsBareNumericId() {
        assertThat(QqUrlParser.parsePlaylistId("7300098051")).isEqualTo("7300098051");
    }

    @Test
    void readsIdFromPlaylistPath() {
        assertThat(QqUrlParser.parsePlaylistId("https://y.qq.com/n/ryqq/playlist/7300098051?ADTAG=share"))
                .isEqualTo("7300098051");
        assertThat(QqUrlParser.parsePlaylistId("https://y.qq.com/n/ryqq/playlist/7300098051#comment"))
                .isEqualTo("7300098051");
    }

    @Test
    void readsIdFromShareQuery() {
        assertThat(QqUrlParser.parsePlaylistId(
                "https://i.y.qq.com/n2/m/share/details/taoge.html?id=7300098051&hosteuin=abc"))
                .isEqualTo("7300098051");
        assertThat(QqUrlParser.parsePlaylistId("https://y.qq.com/#disstid=7300098051"))
                .isEqualTo("7300098051");
    }

    @Test
    void rejectsForeignHost() {
        assertThatThrownBy(() -> QqUrlParser.parsePlaylistId("https://example.com/playlist/7300098051"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("不是 QQ 音乐链接");
    }

    @Test
    void rejectsLinkWithoutPlaylistId() {
        assertThatThrownBy(() -> QqUrlParser.parsePlaylistId("https://y.qq.com/n/ryqq/album/12345"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("没有找到歌单 ID");
    }

    @Test
    void rejectsBlankAndMalformedInput() {
        assertThatThrownBy(() -> QqUrlParser.parsePlaylistId(" "))
                .isInstanceOf(ProviderException.class);
        assertThatThrownBy(() -> QqUrlParser.parsePlaylistId("not-a-link"))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("完整的 QQ 音乐歌单分享链接");
    }
}
