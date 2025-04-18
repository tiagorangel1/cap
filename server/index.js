const crypto = require("crypto");
const fs = require("fs/promises");
const { EventEmitter } = require("events");

const DEFAULT_TOKENS_STORE = ".data/tokensList.json";

(function (define) {
  define(function (require, exports, module) {
    class Cap extends EventEmitter {
      constructor(configObj) {
        super();
        this._cleanupPromise = null;
        this.config = {
          tokens_store_path: DEFAULT_TOKENS_STORE,
          state: {
            challengesList: {},
            tokensList: {},
          },
          ...configObj,
        };

        this._loadTokens().catch(() => { });

        process.on("beforeExit", () => this.cleanup());

        ["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) => {
          process.once(signal, () => {
            this.cleanup()
              .then(() => process.exit(0))
              .catch(() => process.exit(1));
          });
        });
      }

      async _loadTokens() {
        try {
          const dirPath = this.config.tokens_store_path.split('/').slice(0, -1).join('/');
          if (dirPath) {
            await fs.mkdir(dirPath, { recursive: true });
          }

          try {
            await fs.access(this.config.tokens_store_path);
            const data = await fs.readFile(
              this.config.tokens_store_path,
              "utf-8"
            );
            this.config.state.tokensList = JSON.parse(data) || {};
            this._cleanExpiredTokens();
          } catch {
            console.log(
              `[cap] Tokens file not found, creating a new empty one`
            );
            await fs.writeFile(this.config.tokens_store_path, "{}", "utf-8");
            this.config.state.tokensList = {};
          }
        } catch (error) {
          console.log(
            `[cap] Couldn't load or write tokens file, using empty state`
          );
          this.config.state.tokensList = {};
        }
      }

      _cleanExpiredTokens() {
        const now = Date.now();
        let tokensChanged = false;

        for (const k in this.config.state.challengesList) {
          if (this.config.state.challengesList[k].expires < now) {
            delete this.config.state.challengesList[k];
          }
        }

        for (const k in this.config.state.tokensList) {
          if (this.config.state.tokensList[k] < now) {
            delete this.config.state.tokensList[k];
            tokensChanged = true;
          }
        }

        return tokensChanged;
      }

      _waitForTokensList() {
        return new Promise((resolve) => {
          const l = () => {
            if (this.config.state.tokensList) {
              return resolve();
            }
            setTimeout(l, 10);
          };
          l();
        });
      }

      async cleanup() {
        if (this._cleanupPromise) return this._cleanupPromise;

        this._cleanupPromise = (async () => {
          const tokensChanged = this._cleanExpiredTokens();

          if (tokensChanged) {
            await fs.writeFile(
              this.config.tokens_store_path,
              JSON.stringify(this.config.state.tokensList),
              "utf8"
            );
          }
        })();

        return this._cleanupPromise;
      }

      createChallenge(conf) {
        this._cleanExpiredTokens();

        const challenges = Array.from(
          { length: (conf && conf.challengeCount) || 18 },
          () => [
            crypto
              .randomBytes(Math.ceil(((conf && conf.challengeSize) || 32) / 2))
              .toString("hex")
              .slice(0, (conf && conf.challengeSize) || 32),
            crypto
              .randomBytes(
                Math.ceil(((conf && conf.challengeDifficulty) || 4) / 2)
              )
              .toString("hex")
              .slice(0, (conf && conf.challengeDifficulty) || 4),
          ]
        );

        const token = crypto.randomBytes(25).toString("hex");
        const expires = Date.now() + ((conf && conf.expiresMs) || 600000);

        if (conf && conf.store === false) {
          return { challenge: challenges, expires };
        }

        this.config.state.challengesList[token] = {
          challenge: challenges,
          expires,
          token,
        };

        return { challenge: challenges, token, expires };
      }

      async redeemChallenge({ token, solutions }) {
        this._cleanExpiredTokens();

        const challengeData = this.config.state.challengesList[token];
        if (!challengeData || challengeData.expires < Date.now()) {
          delete this.config.state.challengesList[token];
          return { success: false, message: "Challenge expired" };
        }

        delete this.config.state.challengesList[token];

        const isValid = challengeData.challenge.every(([salt, target]) => {
          const solution = solutions.find(
            ([s, t]) => s === salt && t === target
          );
          return (
            solution &&
            crypto
              .createHash("sha256")
              .update(salt + solution[2])
              .digest("hex")
              .startsWith(target)
          );
        });

        if (!isValid) return { success: false, message: "Invalid solution" };

        const vertoken = crypto.randomBytes(15).toString("hex");
        const expires = Date.now() + 20 * 60 * 1000;
        const hash = crypto.createHash("sha256").update(vertoken).digest("hex");
        const id = crypto.randomBytes(8).toString("hex");

        this.config.state.tokensList[`${id}:${hash}`] = expires;

        await fs.writeFile(
          this.config.tokens_store_path,
          JSON.stringify(this.config.state.tokensList),
          "utf8"
        );

        return { success: true, token: `${id}:${vertoken}`, expires };
      }

      async validateToken(token, conf) {
        this._cleanExpiredTokens();

        const [id, vertoken] = token.split(":");
        const hash = crypto.createHash("sha256").update(vertoken).digest("hex");
        const key = `${id}:${hash}`;

        await this._waitForTokensList();

        if (this.config.state.tokensList[key]) {
          if (conf && conf.keepToken) {
            delete this.config.state.tokensList[key];

            await fs.writeFile(
              this.config.tokens_store_path,
              JSON.stringify(this.config.state.tokensList),
              "utf8"
            );
          }

          return { success: true };
        }

        return { success: false };
      }
    }

    return Cap;
  });
})(
  typeof module === "object" && module.exports && typeof define !== "function"
    ? function (factory) {
      module.exports = factory(require, exports, module);
    }
    : define
);
