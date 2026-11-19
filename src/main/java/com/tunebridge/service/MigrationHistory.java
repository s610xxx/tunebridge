package com.tunebridge.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.tunebridge.domain.MigrationJob;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.web.dto.JobView;
import jakarta.annotation.PostConstruct;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

@Repository
@DependsOnDatabaseInitialization
public class MigrationHistory {

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final TransactionTemplate transactions;

    public MigrationHistory(JdbcTemplate jdbc, ObjectMapper mapper, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.transactions = transactions;
    }

    @PostConstruct
    public void recoverInterrupted() {
        transactions.executeWithoutResult(status -> {
            var unfinished = jdbc.query("SELECT id, write_started, snapshot FROM migration_history "
                            + "WHERE status IN ('QUEUED', 'RUNNING', 'AWAITING_CONFIRMATION')",
                    (row, index) -> new Recovery(row.getString("id"), row.getBoolean("write_started"),
                            decode(row.getString("snapshot"))));
            for (Recovery row : unfinished) {
                JobView recovered = row.view().interruptedAfterRestart(row.writeStarted());
                jdbc.update("UPDATE migration_history SET status = 'INTERRUPTED', snapshot = ?, "
                        + "updated_at = CURRENT_TIMESTAMP WHERE id = ?", encode(recovered), row.id());
            }
        });
    }

    public void save(MigrationJob job) {
        synchronized (job) {
            JobView view = JobView.from(job).asReadOnly();
            jdbc.update("MERGE INTO migration_history (id, owner_id, status, write_started, snapshot, "
                            + "created_at, updated_at) KEY(id) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
                    job.id(), job.ownerId(), job.status().name(), job.writeStarted(), encode(view),
                    OffsetDateTime.ofInstant(job.createdAt(), ZoneOffset.UTC));
        }
    }

    public JobView find(String ownerId, String id) {
        return jdbc.query("SELECT snapshot FROM migration_history WHERE owner_id = ? AND id = ?",
                        (row, index) -> decode(row.getString("snapshot")).asReadOnly(), ownerId, id)
                .stream().findFirst().orElseThrow(() -> ProviderException.notFound("迁移任务不存在"));
    }

    public Page list(String ownerId, int offset, int limit) {
        if (offset < 0 || offset > 100_000 || limit < 1 || limit > 50) {
            throw ProviderException.badRequest("历史记录分页参数无效");
        }
        List<JobView> rows = jdbc.query("SELECT snapshot FROM migration_history WHERE owner_id = ? "
                        + "ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                (row, index) -> decode(row.getString("snapshot")).asReadOnly(), ownerId, limit + 1, offset);
        return new Page(rows.size() > limit ? rows.subList(0, limit) : rows, offset, rows.size() > limit);
    }

    private String encode(JobView view) {
        try {
            return mapper.writeValueAsString(view);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("任务报告无法保存");
        }
    }

    private JobView decode(String value) {
        try {
            return mapper.readValue(value, JobView.class);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("任务报告无法读取");
        }
    }

    public record Page(List<JobView> items, int offset, boolean hasMore) {
    }

    private record Recovery(String id, boolean writeStarted, JobView view) {
    }
}
