package com.tunebridge.provider.qq;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.PlaylistRef;
import java.util.List;
import org.junit.jupiter.api.Test;

class QqPlaylistListTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void turnsCreatedDirsIntoSelectableSources() throws Exception {
        JsonNode dirs = mapper.readTree("""
                [
                  {"disstid": 7300098051, "title": "深夜写代码", "song_count": 12,
                   "covermidts": [{"cover_mid": "004FfF1V1KQh6s"}]},
                  {"disstid": "8123", "song_count": 0},
                  {"title": "没有歌单 ID 的脏数据", "song_count": 5}
                ]
                """);

        List<PlaylistRef> refs = QqMusicClient.parseCreatedDiss(dirs, 50);

        assertThat(refs).hasSize(2);
        assertThat(refs.get(0).id()).isEqualTo("7300098051");
        assertThat(refs.get(0).name()).isEqualTo("深夜写代码");
        assertThat(refs.get(0).trackCount()).isEqualTo(12);
        assertThat(refs.get(0).url()).isEqualTo("https://y.qq.com/n/ryqq/playlist/7300098051");
        assertThat(refs.get(0).coverUrl())
                .isEqualTo("https://y.gtimg.cn/music/photo_new/T002R300x300M000004FfF1V1KQh6s.jpg");
        assertThat(refs.get(1).name()).isEqualTo("QQ 歌单 8123");
        assertThat(refs.get(1).coverUrl()).isEmpty();
    }

    @Test
    void stopsAtTheRequestedLimitAndSurvivesUnexpectedShapes() throws Exception {
        List<PlaylistRef> capped = QqMusicClient.parseCreatedDiss(mapper.readTree("""
                [{"disstid": 1, "title": "一"}, {"disstid": 2, "title": "二"}, {"disstid": 3, "title": "三"}]
                """), 2);
        assertThat(capped).hasSize(2);
        assertThat(capped).extracting(PlaylistRef::name).containsExactly("一", "二");

        assertThat(QqMusicClient.parseCreatedDiss(mapper.readTree("{\"vec_diss\":1}").path("vec_diss"), 10))
                .isEmpty();
        assertThat(QqMusicClient.parseCreatedDiss(mapper.readTree("[]"), 10)).isEmpty();
    }
}
