/** The playground's own settings (not problem fields): solve scheduling, label transitions, display. */
import type { LabelStyle } from "./render.js";

export interface View {
  warmStart: boolean;
  settle: boolean;
  transition: number;
  moveDelay: number;
  appearDelay: number;
  holdTime: number;
  collisions: boolean;
  fadeJumps: boolean;
  maxRate: number;
  budgetRest: number;
  budgetMoving: number;
  labelStyle: LabelStyle;
  showBoxes: boolean;
  showOmitted: boolean;
  showCandidates: boolean;
  showObstacles: boolean;
  compare: boolean;
  avoidHud: boolean;
  customJson: string;
  speed: number;
}

export const VIEW_DEFAULTS: View = {
  warmStart: true,
  settle: true,
  transition: 300,
  moveDelay: 500,
  appearDelay: 250,
  holdTime: 500,
  collisions: true,
  fadeJumps: true,
  maxRate: 30,
  budgetRest: 100,
  budgetMoving: 10,
  labelStyle: "box",
  showBoxes: false,
  showOmitted: false,
  showCandidates: false,
  showObstacles: false,
  compare: false,
  avoidHud: true,
  customJson: "",
  speed: 1,
};
