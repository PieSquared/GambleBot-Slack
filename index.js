require("dotenv").config();

const { App } = require("@slack/bolt");

const sessions = new Map();
const balances = new Map();
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

function getSlackConfig(env = process.env) {
  return {
    token: env.SLACK_BOT_TOKEN || env.BOT,
    appToken: env.SLACK_APP_TOKEN || env.APP,
    socketMode: true,
  };
}

function createDeck() {
  const deck = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }

  return deck;
}

function getCardValue(card) {
  if (["J", "Q", "K"].includes(card.rank)) {
    return 10;
  }

  if (card.rank === "A") {
    return 11;
  }

  return Number(card.rank);
}

function getHandValue(cards) {
  let total = cards.reduce((sum, card) => sum + getCardValue(card), 0);
  let aces = cards.filter((card) => card.rank === "A").length;

  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }

  return total;
}

function formatHand(cards) {
  return cards.map((card) => `${card.rank}${card.suit}`).join(" | ");
}

function buildActionBlocks(message) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: message,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Hit",
          },
          action_id: "bj_hit",
          value: "hit",
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Stand",
          },
          action_id: "bj_stand",
          value: "stand",
        },
      ],
    },
  ];
}

function awardCash(userId, amount, won) {
  const balance = getUserBalance(userId);

  if (won) {
    const newBalance = balance + amount;
    balances.set(userId, newBalance);
    return newBalance;
  }

  const newBalance = balance - amount;
  balances.set(userId, newBalance <= 0 ? 50 : newBalance);
  return balances.get(userId);
}

function startNewGame(userId, betAmount) {
  const balance = getUserBalance(userId);
  const amount = betAmount ?? 10;

  if (!Number.isInteger(amount) || amount <= 0) {
    return {
      text: "Please enter a positive whole number of cash for your bet.",
      blocks: [],
    };
  }

  if (amount > balance) {
    return {
      text: `You only have ${formatCurrency(balance)}.`,
      blocks: [],
    };
  }

  const deck = createDeck();
  const playerHand = [deck.pop(), deck.pop()];
  const dealerHand = [deck.pop(), deck.pop()];
  const state = {
    deck,
    playerHand,
    dealerHand,
    playerValue: getHandValue(playerHand),
    dealerValue: getHandValue(dealerHand),
    bet: amount,
  };

  sessions.set(userId, state);

  const intro = `🎲 Blackjack started with a ${formatCurrency(amount)} bet.\nYour hand: ${formatHand(playerHand)} (${state.playerValue})\nDealer shows: ${formatHand([dealerHand[0]])} (${getHandValue([dealerHand[0]])})`;

  return {
    text: `${intro}\nChoose Hit or Stand.`,
    blocks: buildActionBlocks(intro),
  };
}

function takeTurn(userId, action) {
  const state = sessions.get(userId);

  if (!state) {
    return {
      text: "No active game found. Start one with /bj <amount>.",
      blocks: [],
    };
  }

  if (action === "hit") {
    state.playerHand.push(state.deck.pop());
    state.playerValue = getHandValue(state.playerHand);

    if (state.playerValue > 21) {
      awardCash(userId, state.bet, false);
      sessions.delete(userId);
      return {
        text: `💥 Bust! Your hand: ${formatHand(state.playerHand)} (${state.playerValue})\nBalance: ${formatCurrency(getUserBalance(userId))}`,
        blocks: [],
      };
    }

    const message = `🃏 Hit!\nYour hand: ${formatHand(state.playerHand)} (${state.playerValue})\nDealer shows: ${formatHand([state.dealerHand[0]])} (${getHandValue([state.dealerHand[0]])})`;
    return {
      text: `${message}\nChoose Hit or Stand.`,
      blocks: buildActionBlocks(message),
    };
  }

  while (getHandValue(state.dealerHand) < 17) {
    state.dealerHand.push(state.deck.pop());
  }

  state.dealerValue = getHandValue(state.dealerHand);
  sessions.delete(userId);

  if (state.playerValue > state.dealerValue || state.dealerValue > 21) {
    awardCash(userId, state.bet, true);
    return {
      text: `🏆 You win ${formatCurrency(state.bet)}!\nYour hand: ${formatHand(state.playerHand)} (${state.playerValue})\nDealer hand: ${formatHand(state.dealerHand)} (${state.dealerValue})\nBalance: ${formatCurrency(getUserBalance(userId))}`,
      blocks: [],
    };
  }

  if (state.playerValue === state.dealerValue) {
    return {
      text: `🤝 Push!\nYour hand: ${formatHand(state.playerHand)} (${state.playerValue})\nDealer hand: ${formatHand(state.dealerHand)} (${state.dealerValue})\nBalance: ${formatCurrency(getUserBalance(userId))}`,
      blocks: [],
    };
  }

  awardCash(userId, state.bet, false);
  return {
    text: `😔 Dealer wins.\nYour hand: ${formatHand(state.playerHand)} (${state.playerValue})\nDealer hand: ${formatHand(state.dealerHand)} (${state.dealerValue})\nBalance: ${formatCurrency(getUserBalance(userId))}`,
    blocks: [],
  };
}

function flipCoin() {
  const result = Math.random() < 0.5 ? "Heads" : "Tails";
  return `🪙 Coin flip: ${result}`;
}

function getUserBalance(userId) {
  if (!balances.has(userId)) {
    balances.set(userId, 100);
  }

  return balances.get(userId);
}

function formatCurrency(amount) {
  return `$${amount}`;
}

function handleCashCommand(userId) {
  const balance = getUserBalance(userId);
  return `💰 Your balance is ${formatCurrency(balance)}.`;
}

function handleGambleCommand(userId, rawAmount) {
  const balance = getUserBalance(userId);

  if (!rawAmount) {
    return `Usage: /gamble <amount>\nYour balance: ${formatCurrency(balance)}`;
  }

  const amount = Number(rawAmount);

  if (!Number.isInteger(amount) || amount <= 0) {
    return "Please enter a positive whole number of cash.";
  }

  if (amount > balance) {
    return `You only have ${formatCurrency(balance)}.`;
  }

  const won = Math.random() < 0.5;

  if (won) {
    const newBalance = balance + amount;
    balances.set(userId, newBalance);
    return `🎉 You won ${formatCurrency(amount)}!\nNew balance: ${formatCurrency(newBalance)}`;
  }

  const newBalance = balance - amount;

  if (newBalance <= 0) {
    balances.set(userId, 50);
    return `💸 You lost ${formatCurrency(amount)}.\nYou are out of cash, so you received ${formatCurrency(50)} to get back in the game.`;
  }

  balances.set(userId, newBalance);
  return `💸 You lost ${formatCurrency(amount)}.\nNew balance: ${formatCurrency(newBalance)}`;
}

function handleCoinflipCommand(userId, pick, rawAmount) {
  const balance = getUserBalance(userId);

  if (!pick || !rawAmount) {
    return `Usage: /cf <heads|tails> <amount>\nYour balance: ${formatCurrency(balance)}`;
  }

  const amount = Number(rawAmount);
  const choice = pick.toLowerCase();

  if (!["heads", "tails"].includes(choice)) {
    return "Choose heads or tails.";
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    return "Please enter a positive whole number of cash.";
  }

  if (amount > balance) {
    return `You only have ${formatCurrency(balance)}.`;
  }

  const result = Math.random() < 0.5 ? "heads" : "tails";
  const won = result === choice;

  if (won) {
    const newBalance = balance + amount;
    balances.set(userId, newBalance);
    return `🎉 ${result} wins! You won ${formatCurrency(amount)}.\nBalance: ${formatCurrency(newBalance)}`;
  }

  const newBalance = balance - amount;
  if (newBalance <= 0) {
    balances.set(userId, 50);
    return `💸 ${result} wins. You lost ${formatCurrency(amount)}.\nYou are out of cash, so you received ${formatCurrency(50)} to get back in the game.`;
  }

  balances.set(userId, newBalance);
  return `💸 ${result} wins. You lost ${formatCurrency(amount)}.\nBalance: ${formatCurrency(newBalance)}`;
}

function registerCommands(app) {
  app.command("/bj", async ({ command, ack, respond }) => {
    const startedAt = Date.now();
    await ack();
    const latency = Date.now() - startedAt;

    const userId = command.user_id || "unknown";
    const text = (command.text || "").trim();
    const tokens = text.split(/\s+/).filter(Boolean);
    const action = (tokens[0] || "new").toLowerCase();
    const betAmount = tokens[1] ? Number(tokens[1]) : undefined;

    let result = {
      text: `🎲 Blackjack ready.\nLatency: ${latency}ms`,
      blocks: [],
    };

    if (action === "new" || Number.isInteger(Number(action))) {
      const amount = Number.isInteger(Number(action)) ? Number(action) : betAmount;
      result = startNewGame(userId, amount);
    } else if (action === "hit" || action === "stand") {
      result = takeTurn(userId, action);
    } else {
      result = {
        text: "Use /bj <amount> to start a new game, or /bj hit / /bj stand to play.",
        blocks: [],
      };
    }

    await respond({ text: result.text, blocks: result.blocks });
  });

  app.command("/cf", async ({ command, ack, respond }) => {
    await ack();
    const userId = command.user_id || "unknown";
    const tokens = (command.text || "").trim().split(/\s+/).filter(Boolean);
    const pick = tokens[0];
    const amount = tokens[1];
    await respond({ text: handleCoinflipCommand(userId, pick, amount) });
  });

  app.command("/coinflip", async ({ command, ack, respond }) => {
    await ack();
    const userId = command.user_id || "unknown";
    const tokens = (command.text || "").trim().split(/\s+/).filter(Boolean);
    const pick = tokens[0];
    const amount = tokens[1];
    await respond({ text: handleCoinflipCommand(userId, pick, amount) });
  });

  app.command("/cash", async ({ command, ack, respond }) => {
    await ack();
    const userId = command.user_id || "unknown";
    await respond({ text: handleCashCommand(userId) });
  });

  app.command("/gamble", async ({ command, ack, respond }) => {
    await ack();
    const userId = command.user_id || "unknown";
    const amount = (command.text || "").trim();
    await respond({ text: handleGambleCommand(userId, amount) });
  });

  app.action("bj_hit", async ({ ack, body, respond }) => {
    await ack();
    const userId = body.user?.id || "unknown";
    const result = takeTurn(userId, "hit");
    await respond({ text: result.text, blocks: result.blocks });
  });

  app.action("bj_stand", async ({ ack, body, respond }) => {
    await ack();
    const userId = body.user?.id || "unknown";
    const result = takeTurn(userId, "stand");
    await respond({ text: result.text, blocks: result.blocks });
  });
}

async function startBot() {
  const config = getSlackConfig();

  if (!config.token || !config.appToken) {
    console.error("Missing Slack credentials. Set SLACK_BOT_TOKEN/SLACK_APP_TOKEN or BOT/APP in your .env file.");
    process.exit(1);
  }

  const app = new App(config);
  registerCommands(app);
  await app.start();
  console.log("bot is running!");
}

if (require.main === module) {
  startBot().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  getSlackConfig,
  startBot,
};