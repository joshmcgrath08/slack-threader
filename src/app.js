const fetch = require("node-fetch");
const { App } = require("@slack/bolt");

// Constants

const MESSAGES_LOOK_BEHIND = 25;
const SEAGULL_FLIGHT_BASE_URL = "https://api.seagullflight.com";

// Helper classes

class DbClient {
  constructor(credentialToken) {
    this.credentialToken = credentialToken;
  }

  doQuery(queryStr, args, modeArg) {
    const mode = modeArg || "single";
    if (mode !== "single" && mode !== "multi" && mode !== "script") {
      console.error("Invalid mode", mode);
      return null;
    }
    return this.doFetch(
      "/db/query",
      {
        method: "POST",
        body: JSON.stringify({
          args: args || [],
          query: queryStr
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + this.credentialToken
        }
      },
      { mode }
    );
  }

  doFetch(urlStr, opts, params) {
    const url = new URL(SEAGULL_FLIGHT_BASE_URL + urlStr);
    if (params) {
      url.search = new URLSearchParams(params).toString();
    }
    return fetch(url, opts)
      .then(r => r.json())
      .catch(e => console.error("Error making call", url, e));
  }
}

class InstallationStore {
  constructor(dbClient) {
    this.dbClient = dbClient;
  }

  async putInstallation(installation) {
    console.log("Creating installation", JSON.stringify(installation));
    await this.dbClient.doQuery(
      "INSERT INTO teamInstallations(teamId, installation) VALUES (?, ?);",
      [installation.team.id, JSON.stringify(installation)]
    );
    if (installation.user) {
      await this.dbClient.doQuery(
        "INSERT INTO userInstallations(teamId, userId, installation) VALUES (?, ?, ?);",
        [
          installation.team.id,
          installation.user.id,
          JSON.stringify(installation.user)
        ]
      );
    }
  }

  async getInstallationByTeamId(teamId) {
    return this.dbClient
      .doQuery("SELECT installation FROM teamInstallations WHERE teamId = ?", [
        teamId
      ])
      .then(
        r =>
          r &&
          r.results &&
          r.results[0].installation &&
          JSON.parse(r.results[0].installation)
      );
  }

  async getUserByTeamIdAndUserId(teamId, userId) {
    return this.dbClient
      .doQuery(
        "SELECT installation FROM userInstallations WHERE teamId = ? AND userId = ?",
        [teamId, userId]
      )
      .then(
        r =>
          r &&
          r.results &&
          r.results[0].installation &&
          JSON.parse(r.results[0].installation)
      );
  }
}

class MessageStore {
  constructor(dbClient) {
    this.dbClient = dbClient;
  }

  async putMessage(message) {
    console.log("Putting message", JSON.stringify(message));
    return this.dbClient.doQuery(
      `INSERT INTO messages (teamId, channelId, userId, threadTs, ts, fromBot, text)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        message.teamId,
        message.channelId,
        message.userId,
        message.threadTs,
        message.ts,
        message.fromBot,
        message.text
      ]
    );
  }

  async updateMessage(message) {
    console.log("Updating message", JSON.stringify(message));
    await this.dbClient.doQuery(
      `UPDATE messages SET text = ?
WHERE teamId = ? AND channelId = ? AND ts = ? AND threadTs = ?`,
      [
        message.text,
        message.team,
        message.channel,
        message.ts,
        message.threadTs
      ]
    );
  }

  async deleteMessage(message) {
    console.log("Deleting message", JSON.stringify(message));
    await this.dbClient.doQuery(
      "DELETE FROM messages WHERE teamId = ? AND channelId = ? AND ts = ? AND threadTs = ?",
      [message.team, message.channel, message.ts, message.threadTs]
    );
  }

  async getMostRecent(teamId, channelId) {
    return this.dbClient.doQuery(
      "SELECT * FROM messages WHERE teamId = ? AND channelId = ? ORDER BY ts DESC LIMIT ?;",
      [teamId, channelId, MESSAGES_LOOK_BEHIND]
    );
  }

  async getMostRecentForUser(teamId, channelId, userId) {
    return this.dbClient.doQuery(
      `SELECT * FROM messages
WHERE teamId = ? AND channelId = ? AND userId = ? ORDER BY ts DESC LIMIT ?;`,
      [teamId, channelId, userId, MESSAGES_LOOK_BEHIND]
    );
  }
}

class HelloWorldThreader {
  constructor(messageStore) {
    this.messageStore = messageStore;
  }

  async getTargetThread(message) {
    if (message.text === "world") {
      const mostRecent = await messageStore.getMostRecent(
        message.teamId,
        message.channelId
      );
      for (let m of mostRecent.results) {
        if (m.text === "hello") {
          return m.threadTs === null ? m.ts : m.threadTs;
        }
      }
    }
    return null;
  }
}

class StreamOfConsciousnessThreader {
  constructor(messageStore) {
    this.messageStore = messageStore;
  }

  async getTargetThread(message) {
    const elippsisRe = new RegExp("^\\.\\.\\..*");
    if (message.text.match(elippsisRe)) {
      let mostRecent = await messageStore.getMostRecentForUser(
        message.teamId,
        message.channelId,
        message.userId
      );
      for (let m of mostRecent.results.filter(m => m.ts != message.ts)) {
        return m.threadTs === null ? m.ts : m.threadTs;
      }
    }
    return null;
  }
}

class ReAtThreader {
  constructor(messageStore) {
    this.messageStore = messageStore;
  }

  async getTargetThread(message) {
    const targetUserRe = new RegExp("^(?:re|RE|Re) *:? * <@(U[A-Z0-9]+)>.*");
    if (message.text.match(targetUserRe)) {
      const targetUserId = targetUserRe.exec(message.text)[1];
      const mostRecent = await messageStore.getMostRecentForUser(
        message.teamId,
        message.channelId,
        message.userId
      );
      for (let m of mostRecent.results.filter(m => m.ts != message.ts)) {
        return m.threadTs === null ? m.ts : m.threadTs;
      }
    }
    return null;
  }
}

class SequentialThreaderCombinator {
  constructor(threaders) {
    this.threaders = threaders;
  }

  async getTargetThread(message) {
    for (let threader of this.threaders) {
      const targetThreadTs = await threader.getTargetThread(message);
      if (targetThreadTs) {
        return targetThreadTs;
      }
    }
    return null;
  }
}

// Application logic

class OnMessageImpl {
  constructor(slackApp, messageStore, installationStore, threader) {
    this.slackApp = slackApp;
    this.messageStore = messageStore;
    this.installationStore = installationStore;
    this.threader = threader;
  }

  async onMessage(event) {
    if (event.subtype === "message_deleted") {
      this.onMessageDeleted(event);
    } else if (event.subtype === "message_changed") {
      this.onMessageChanged(event);
    } else if (event.subtype === undefined) {
      await this.onMessageCreated(event);
    }
  }

  onMessageDeleted(event) {
    this.messageStore.deleteMessage({
      ts: event.previous_message.ts,
      channelId: event.channel,
      threadTs: event.previous_message.thread_ts,
      teamId: event.previous_message.team
    });
  }

  onMessageChanged(event) {
    if (event.message.text !== event.previous_message.text) {
      this.messageStore.updateMessage({
        text: event.message.text,
        userId: event.message.user,
        ts: event.message.ts,
        threadTs: event.message.thread_ts,
        channelId: event.channel,
        teamId: event.previous_message.team
      });
    }
  }

  async onMessageCreated(event) {
    const message = {
      text: event.text,
      userId: event.user,
      ts: event.ts,
      threadTs: event.thread_ts,
      channelId: event.channel,
      teamId: event.team,
      fromBot: event.bot_profile !== undefined
    };

    this.messageStore.putMessage(message);

    if (!message.threadTs) {
      const targetThreadTs = await this.threader.getTargetThread(message);

      if (targetThreadTs) {
        const user = await this.installationStore.getUserByTeamIdAndUserId(
          message.teamId,
          message.userId
        );
        if (!user) {
          console.warn("No permissions for", JSON.stringify(message.userId));
          return;
        }
        console.info(
          "Moving message to new thread",
          JSON.stringify(message),
          targetThreadTs
        );
        await this.slackApp.client.chat.postMessage({
          token: user.token,
          channel: message.channelId,
          thread_ts: targetThreadTs,
          text: message.text,
          as_user: true,
          username: message.userId
        });
        await this.slackApp.client.chat.delete({
          token: user.token,
          channel: message.channelId,
          ts: message.ts,
          as_user: true
        });
      } else {
        console.debug(
          "No target thread identified for message",
          JSON.stringify(message)
        );
      }
    }
  }
}

// Application initialization

const dbClient = new DbClient(process.env.SEAGULL_FLIGHT_TOKEN);

const messageStore = new MessageStore(dbClient);
const installationStore = new InstallationStore(dbClient);

const threader = new SequentialThreaderCombinator([
  new ReAtThreader(messageStore),
  new StreamOfConsciousnessThreader(messageStore),
  new HelloWorldThreader(messageStore)
]);

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: ["channels:history", "chat:write", "chat:write.customize"],
  installationStore: {
    storeInstallation: installation => {
      installationStore.putInstallation(installation);
    },
    fetchInstallation: installationQuery => {
      return installationStore.getInstallationByTeamId(
        installationQuery.teamId
      );
    }
  },
  installerOptions: {
    authVersion: "v2",
    userScopes: ["chat:write"]
  }
});

const onMessageImpl = new OnMessageImpl(
  app,
  messageStore,
  installationStore,
  threader
);

// Hook up event listener and web server

app.event("message", async ({ event, context }) => {
  onMessageImpl.onMessage(event);
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Bolt app is running!");
})();
