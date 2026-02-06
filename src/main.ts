import "./style.css";
import { FpsGame } from "./game/FpsGame";

const app = document.getElementById("app");

if (!app) {
  throw new Error("Missing app root");
}

const game = new FpsGame(app);
void game.init();

if (import.meta.env.DEV) {
  (
    window as Window & {
      __shadowProtocolGame?: FpsGame;
    }
  ).__shadowProtocolGame = game;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.destroy();
  });
}
