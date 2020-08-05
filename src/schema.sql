CREATE TABLE teamInstallations (
       teamId TEXT PRIMARY KEY,
       installation TEXT NOT NULL
);

CREATE TABLE userInstallations (
       teamId TEXT NOT NULL,
       userId TEXT NOT NULL,
       installation TEXT NOT NULL,
       PRIMARY KEY(teamId, userId)
);

CREATE TABLE messages (
       teamId TEXT NOT NULL,
       channelId TEXT NOT NULL,
       userId TEXT NOT NULL,
       threadTs TEXT DEFAULT NULL,
       ts TEXT NOT NULL,
       fromBot INT NOT NULL DEFAULT 0,
       text TEXT NOT NULL,
       PRIMARY KEY(teamId, channelId, userId, ts)
);
