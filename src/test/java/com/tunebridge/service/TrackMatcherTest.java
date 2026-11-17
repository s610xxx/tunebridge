package com.tunebridge.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.tunebridge.domain.Track;
import java.util.List;
import org.junit.jupiter.api.Test;

class TrackMatcherTest {

    private final TrackMatcher matcher = new TrackMatcher();

    @Test
    void matchesExactTitleAndArtist() {
        Track source = Track.of("1", "晴天", "周杰伦", "叶惠美", 269);
        Track candidate = Track.of("2", "晴天", "周杰伦", "叶惠美", 269);

        TrackMatcher.Evaluation evaluation = matcher.evaluate(source, List.of(candidate));

        assertThat(evaluation.matched()).isTrue();
        assertThat(evaluation.lowConfidence()).isFalse();
        assertThat(evaluation.score()).isGreaterThan(0.95);
        assertThat(evaluation.note()).contains("标题与歌手一致");
    }

    @Test
    void acceptsVersionDifferenceButFlagsIt() {
        Track source = Track.of("1", "晴天", "周杰伦", "叶惠美", 269);
        Track candidate = Track.of("2", "晴天 (Live)", "周杰伦", "地表最强世界巡回演唱会", 271);

        TrackMatcher.Evaluation evaluation = matcher.evaluate(source, List.of(candidate));

        assertThat(evaluation.matched()).isTrue();
        assertThat(evaluation.note()).contains("版本差异");
    }

    @Test
    void marksWeakArtistMatchAsLowConfidence() {
        Track source = Track.of("1", "起风了", "买辣椒也用券", "起风了", 325);
        Track candidate = Track.of("2", "起风了", "周杰伦", "叶惠美", 325);

        TrackMatcher.Evaluation evaluation = matcher.evaluate(source, List.of(candidate));

        assertThat(evaluation.matched()).isTrue();
        assertThat(evaluation.lowConfidence()).isTrue();
        assertThat(evaluation.score()).isBetween(0.55, 0.72);
        assertThat(evaluation.note()).contains("建议试听");
    }

    @Test
    void rejectsUnrelatedCandidate() {
        Track source = Track.of("1", "晴天", "周杰伦", "叶惠美", 269);
        Track candidate = Track.of("2", "稻香", "周杰伦", "魔杰座", 223);

        TrackMatcher.Evaluation evaluation = matcher.evaluate(source, List.of(candidate));

        assertThat(evaluation.matched()).isFalse();
        assertThat(evaluation.note()).contains("未找到足够相似的版本");
    }

    @Test
    void rejectsEmptyCandidateList() {
        Track source = Track.of("1", "晴天", "周杰伦", "叶惠美", 269);

        TrackMatcher.Evaluation evaluation = matcher.evaluate(source, List.of());

        assertThat(evaluation.matched()).isFalse();
        assertThat(evaluation.score()).isZero();
    }

    @Test
    void normalizationIgnoresBracketsPunctuationAndWidth() {
        assertThat(matcher.normalize("晴天（Live 版）")).isEqualTo("晴天");
        assertThat(matcher.normalize("Hello, World!")).isEqualTo("helloworld");
        assertThat(matcher.normalize("ＡＢＣ　１２３")).isEqualTo("abc123");
    }
}
