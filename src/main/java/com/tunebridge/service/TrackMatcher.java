package com.tunebridge.service;

import com.tunebridge.domain.Track;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

@Component
public class TrackMatcher {

    private static final Pattern BRACKETS = Pattern.compile("[\\(（\\[【].*?[\\)）\\]】]");
    private static final Pattern VERSION_MARKER = Pattern.compile(
            "(?i)live|remix|acoustic|remaster|instrumental|demo|cover|现场|翻唱|伴奏|纯音乐|重制|混音");
    private static final Pattern ARTIST_SPLIT = Pattern.compile("\\s*(?:/|,|，|&|＆|、|;|；|\\bfeat\\.?\\b|\\bft\\.?\\b|\\bwith\\b)\\s*",
            Pattern.CASE_INSENSITIVE);

    public Evaluation evaluate(Track source, List<Track> candidates) {
        if (candidates == null || candidates.isEmpty()) {
            return new Evaluation(null, 0, false, false, "目标平台未找到这首歌");
        }
        Track best = null;
        double bestScore = -1;
        for (Track candidate : candidates) {
            double score = score(source, candidate);
            if (score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
        if (best == null || bestScore < 0.55) {
            String closest = best == null ? "" :
                    "（最接近：" + best.title() + " · " + best.artist() + "，相似度 " + percent(bestScore) + "）";
            return new Evaluation(null, Math.max(0, bestScore), false, false, "未找到足够相似的版本" + closest);
        }

        boolean lowConfidence = bestScore < 0.72;
        boolean versionMismatch = VERSION_MARKER.matcher(source.title()).find()
                != VERSION_MARKER.matcher(best.title()).find();
        StringBuilder note = new StringBuilder();
        if (versionMismatch) {
            note.append("检测到 Live / Remix 等版本差异");
        }
        if (lowConfidence) {
            if (!note.isEmpty()) {
                note.append("；");
            }
            note.append("相似度较低，建议试听确认");
        }
        if (note.isEmpty()) {
            if (normalize(source.title()).equals(normalize(best.title()))
                    && artistSimilarity(source.artist(), best.artist()) >= 0.8) {
                note.append("标题与歌手一致");
            } else if (normalize(source.title()).equals(normalize(best.title()))) {
                note.append("标题一致，歌手信息有差异");
            } else {
                note.append("标题与歌手近似");
            }
        }
        return new Evaluation(best, bestScore, true, lowConfidence, note.toString());
    }

    public double score(Track source, Track candidate) {
        double titleScore = similarity(normalize(source.title()), normalize(candidate.title()));
        double artistScore = artistSimilarity(source.artist(), candidate.artist());
        double albumScore = albumSimilarity(source.album(), candidate.album());
        double score = 0.60 * titleScore + 0.34 * artistScore + 0.06 * albumScore;

        boolean sourceVersion = VERSION_MARKER.matcher(source.title()).find();
        boolean targetVersion = VERSION_MARKER.matcher(candidate.title()).find();
        if (sourceVersion != targetVersion) {
            score -= 0.08;
        }
        return Math.max(0, Math.min(1, score));
    }

    public String normalize(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder halfWidth = new StringBuilder(value.length());
        for (char ch : value.toCharArray()) {
            if (ch >= 0xFF01 && ch <= 0xFF5E) {
                halfWidth.append((char) (ch - 0xFEE0));
            } else if (ch == 0x3000) {
                halfWidth.append(' ');
            } else {
                halfWidth.append(ch);
            }
        }
        String result = BRACKETS.matcher(halfWidth.toString()).replaceAll(" ");
        result = result.toLowerCase(Locale.ROOT);
        return result.replaceAll("[^\\p{L}\\p{N}]", "");
    }

    private double artistSimilarity(String sourceArtist, String targetArtist) {
        List<String> sourceParts = splitArtists(sourceArtist);
        List<String> targetParts = splitArtists(targetArtist);
        if (sourceParts.isEmpty() && targetParts.isEmpty()) {
            return 0.6;
        }
        if (sourceParts.isEmpty() || targetParts.isEmpty()) {
            return 0.4;
        }
        double best = 0;
        for (String source : sourceParts) {
            for (String target : targetParts) {
                best = Math.max(best, similarity(source, target));
            }
        }
        return best;
    }

    private List<String> splitArtists(String artist) {
        if (artist == null || artist.isBlank()) {
            return List.of();
        }
        List<String> parts = new ArrayList<>();
        for (String part : ARTIST_SPLIT.split(artist)) {
            String normalized = normalize(part);
            if (!normalized.isBlank()) {
                parts.add(normalized);
            }
        }
        return parts;
    }

    private double albumSimilarity(String sourceAlbum, String targetAlbum) {
        String source = normalize(sourceAlbum);
        String target = normalize(targetAlbum);
        if (source.isBlank() || target.isBlank()) {
            return 0.5;
        }
        if (source.equals(target)) {
            return 1;
        }
        return source.contains(target) || target.contains(source) ? 0.6 : 0;
    }

    private double similarity(String a, String b) {
        if (a == null || b == null || a.isBlank() || b.isBlank()) {
            return 0;
        }
        if (a.equals(b)) {
            return 1;
        }
        int min = Math.min(a.length(), b.length());
        int max = Math.max(a.length(), b.length());
        if (min >= 2 && (a.contains(b) || b.contains(a)) && min * 1.0 / max >= 0.6) {
            return 0.88;
        }
        if (a.length() < 2 || b.length() < 2) {
            return 0;
        }
        List<String> left = bigrams(a);
        List<String> right = bigrams(b);
        int intersection = 0;
        List<String> copy = new ArrayList<>(right);
        for (String gram : left) {
            if (copy.remove(gram)) {
                intersection++;
            }
        }
        return (2.0 * intersection) / (left.size() + right.size());
    }

    private List<String> bigrams(String value) {
        List<String> grams = new ArrayList<>(Math.max(0, value.length() - 1));
        for (int i = 0; i < value.length() - 1; i++) {
            grams.add(value.substring(i, i + 2));
        }
        return grams;
    }

    private static int percent(double score) {
        return (int) Math.round(score * 100);
    }

    public record Evaluation(Track candidate, double score, boolean matched,
                             boolean lowConfidence, String note) {
    }
}
