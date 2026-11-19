package com.tunebridge.web.dto;

import com.tunebridge.domain.LogEntry;
import com.tunebridge.domain.MigrationJob;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.TrackMatch;
import java.util.List;
import java.util.stream.IntStream;

public record JobView(
        String id,
        String status,
        int progress,
        String currentStep,
        SourceView source,
        TargetView target,
        List<LogEntry> logs,
        List<MatchView> matches,
        ResultView result,
        String error,
        String createdAt,
        boolean readOnly,
        String recoveryNotice,
        CreatedTargetView createdTarget
) {
    public static JobView from(MigrationJob job) {
        synchronized (job) {
            return snapshot(job);
        }
    }

    private static JobView snapshot(MigrationJob job) {
        Playlist sourcePlaylist = job.sourcePlaylist();
        String sourceProvider = job.sourceLabel() == null
                ? job.sourceProvider().name() : "LOCAL_BACKUP";
        String sourceLabel = job.sourceLabel() == null
                ? job.sourceProvider().label() : job.sourceLabel();
        SourceView source = sourcePlaylist == null ? new SourceView(sourceProvider,
                sourceLabel, job.requestedName().isBlank() ? "正在读取歌单" : job.requestedName(),
                "", "", 0) : new SourceView(
                sourceProvider,
                sourceLabel,
                sourcePlaylist.name(),
                sourcePlaylist.coverUrl(),
                sourcePlaylist.owner(),
                sourcePlaylist.tracks().size()
        );
        TargetView target = new TargetView(job.targetProvider().name(), job.targetProvider().label(),
                job.targetMode().name());
        List<TrackMatch> snapshot = job.matchesSnapshot();
        List<Integer> selected = job.selectedIndicesSnapshot();
        List<MatchView> matches = IntStream.range(0, snapshot.size())
                .mapToObj(index -> MatchView.from(index, snapshot.get(index), selected.contains(index))).toList();

        ResultView result = null;
        if (job.result() != null) {
            int added = job.result().trackCount();
            int total = matches.size();
            int matched = (int) matches.stream().filter(MatchView::matched).count();
            int unmatched = total - matched;
            int skipped = matched - added;
            int rate = total == 0 ? 0 : (int) Math.round(matched * 100.0 / total);
            result = new ResultView(job.result().id(), job.result().name(), job.result().url(),
                    added, unmatched, total, rate, skipped, matched);
        }

        return new JobView(job.id(), job.status().name(), job.progress(), job.currentStep(),
                source, target, job.logsSnapshot(), matches, result,
                job.error().isBlank() ? null : job.error(), job.createdAt().toString(), false,
                job.recoveryNotice(), job.createdTarget() == null ? null : new CreatedTargetView(
                        job.createdTarget().id(), job.createdTarget().name(), job.createdTarget().url()));
    }

    public JobView asReadOnly() {
        return new JobView(id, status, progress, currentStep, source, target, logs, matches, result, error,
                createdAt, true, recoveryNotice, createdTarget);
    }

    public JobView interruptedAfterRestart(boolean writeStarted) {
        String notice = writeStarted
                ? "服务重启时任务处于写入阶段，结果待核查；目标平台可能已创建歌单或加入歌曲，请手动检查，勿自动重试。"
                : "服务重启，任务已中断；未开始写入目标平台。请重新登录、连接并匹配，未确认预览不会自动恢复。";
        return new JobView(id, "INTERRUPTED", progress, writeStarted ? "写入结果待核查" : "任务已中断",
                source, target, logs, matches, result, notice, createdAt, true, notice, createdTarget);
    }

    public record CreatedTargetView(String playlistId, String playlistName, String playlistUrl) {
    }

    public record SourceView(
            String provider,
            String providerLabel,
            String name,
            String coverUrl,
            String owner,
            int trackCount
    ) {
    }

    public record TargetView(String provider, String providerLabel, String mode) {
    }

    public record MatchView(
            int index,
            boolean selected,
            String title,
            String artist,
            String album,
            int durationSec,
            boolean matched,
            boolean lowConfidence,
            String targetTitle,
            String targetArtist,
            String targetAlbum,
            String targetArtworkUrl,
            int score,
            String note
    ) {
        public static MatchView from(int index, TrackMatch match, boolean selected) {
            return new MatchView(
                    index,
                    selected,
                    match.source().title(),
                    match.source().artist(),
                    match.source().album(),
                    match.source().durationSec(),
                    match.matched(),
                    match.lowConfidence(),
                    match.targetTitle(),
                    match.targetArtist(),
                    match.targetAlbum(),
                    match.targetArtworkUrl(),
                    (int) Math.round(match.score() * 100),
                    match.note()
            );
        }
    }

    public record ResultView(
            String playlistId,
            String playlistName,
            String playlistUrl,
            int addedCount,
            int unmatchedCount,
            int totalCount,
            int matchRate,
            int skippedCount,
            int matchedCount
    ) {
    }
}
