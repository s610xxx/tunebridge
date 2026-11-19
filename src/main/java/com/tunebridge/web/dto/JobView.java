package com.tunebridge.web.dto;

import com.tunebridge.domain.LogEntry;
import com.tunebridge.domain.MigrationJob;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.TrackMatch;
import java.util.List;

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
        String createdAt
) {
    public static JobView from(MigrationJob job) {
        Playlist sourcePlaylist = job.sourcePlaylist();
        String sourceProvider = job.sourceLabel() == null
                ? job.sourceProvider().name() : "LOCAL_BACKUP";
        String sourceLabel = job.sourceLabel() == null
                ? job.sourceProvider().label() : job.sourceLabel();
        SourceView source = sourcePlaylist == null ? null : new SourceView(
                sourceProvider,
                sourceLabel,
                sourcePlaylist.name(),
                sourcePlaylist.coverUrl(),
                sourcePlaylist.owner(),
                sourcePlaylist.tracks().size()
        );
        TargetView target = new TargetView(job.targetProvider().name(), job.targetProvider().label());
        List<MatchView> matches = job.matchesSnapshot().stream().map(MatchView::from).toList();

        ResultView result = null;
        if (job.result() != null) {
            int added = job.result().trackCount();
            int total = matches.size();
            int unmatched = Math.max(0, total - added);
            int rate = total == 0 ? 0 : (int) Math.round(added * 100.0 / total);
            result = new ResultView(job.result().id(), job.result().name(), job.result().url(),
                    added, unmatched, total, rate);
        }

        return new JobView(job.id(), job.status().name(), job.progress(), job.currentStep(),
                source, target, job.logsSnapshot(), matches, result,
                job.error().isBlank() ? null : job.error(), job.createdAt().toString());
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

    public record TargetView(String provider, String providerLabel) {
    }

    public record MatchView(
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
        public static MatchView from(TrackMatch match) {
            return new MatchView(
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
            int matchRate
    ) {
    }
}
