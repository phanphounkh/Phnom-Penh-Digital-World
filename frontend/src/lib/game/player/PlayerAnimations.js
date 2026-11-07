import {
  AnimationMixer,
  AnimationClip,
  NumberKeyframeTrack,
  Vector3,
  MathUtils,
} from "three";
/** Distance-driven gait and two-bone arms use the articulated Blender pivots. */
export class PlayerAnimations {
  constructor(model, { pushing = false } = {}) {
    this.model = model;
    this.pushing = pushing;
    this.mixer = new AnimationMixer(model);
    this.actions = {};
    this.state = "";
    this.target = new Vector3();
    this.body = model.getObjectByName("BodyRoot");
    this.phase = 0;
    const track = (name, values) =>
      new NumberKeyframeTrack(
        name + ".rotation[x]",
        [0, 0.25, 0.5, 0.75, 1],
        values,
      );
    for (const [name, stride, knee] of [
      ["idle", 0, 0],
      ["walk", 0.42, 0.58],
      ["run", 0.66, 0.92],
      ["carry", 0.32, 0.46],
    ]) {
      const tracks = [
        track("LeftLeg", [0, stride, 0, -stride, 0]),
        track("RightLeg", [0, -stride, 0, stride, 0]),
        track("LeftKnee", [0.04, knee, 0.04, 0.02, 0.04]),
        track("RightKnee", [0.04, 0.02, 0.04, knee, 0.04]),
      ];
      this.actions[name] = this.mixer.clipAction(
        new AnimationClip(name, 1, tracks),
      );
    }
    this.arms = ["Left", "Right"].map((side) => ({
      shoulder: model.getObjectByName(side + "Arm"),
      elbow: model.getObjectByName(side + "Elbow"),
      wrist: model.getObjectByName(side + "Wrist"),
    }));
  }
  solveArm(arm, worldTarget, dt) {
    if (!arm.shoulder || !arm.elbow) return;
    this.target.copy(worldTarget);
    arm.shoulder.parent.worldToLocal(this.target);
    this.target.sub(arm.shoulder.position);
    const upper = 0.29,
      lower = 0.28,
      d = MathUtils.clamp(
        Math.hypot(this.target.y, this.target.z),
        0.06,
        upper + lower - 0.003,
      );
    const aim = Math.atan2(-this.target.z, -this.target.y),
      bend = Math.acos(
        MathUtils.clamp(
          (d * d - upper * upper - lower * lower) / (2 * upper * lower),
          -1,
          1,
        ),
      );
    const offset = Math.acos(
      MathUtils.clamp(
        (upper * upper + d * d - lower * lower) / (2 * upper * d),
        -1,
        1,
      ),
    );
    const blend = 1 - Math.exp(-dt * 20);
    arm.shoulder.rotation.x = MathUtils.lerp(
      arm.shoulder.rotation.x,
      aim + offset,
      blend,
    );
    arm.elbow.rotation.x = MathUtils.lerp(arm.elbow.rotation.x, -bend, blend);
    arm.shoulder.rotation.z = MathUtils.lerp(
      arm.shoulder.rotation.z,
      MathUtils.clamp(this.target.x / d, -0.18, 0.18),
      blend,
    );
    if (arm.wrist)
      arm.wrist.rotation.x =
        -(arm.shoulder.rotation.x + arm.elbow.rotation.x) - 0.75;
  }
  update(
    dt,
    speed,
    holding = false,
    picking = false,
    targets = null,
    travel = 0,
    direction = 1,
  ) {
    const state =
      speed < 0.07 ? "idle" : holding ? "carry" : speed > 4 ? "run" : "walk";
    if (this.state !== state) {
      this.actions[this.state]?.fadeOut(0.16);
      this.actions[state].reset().fadeIn(0.16).play();
      this.state = state;
    }
    this.actions[state].timeScale =
      speed > 0.07 ? (direction * speed) / (state === "run" ? 2.4 : 1.7) : 1;
    this.mixer.update(dt);
    this.phase += (direction * travel * 2 * Math.PI) / 1.7;
    if (this.body) {
      const drops = ["Left", "Right"].map((side) => {
        const hip = this.model.getObjectByName(side + "Leg"),
          knee = this.model.getObjectByName(side + "Knee"),
          ankle = this.model.getObjectByName(side + "Ankle");
        if (!hip || !knee) return 0.82;
        if (ankle) ankle.rotation.x = -(hip.rotation.x + knee.rotation.x);
        return (
          0.42 * Math.cos(hip.rotation.x) +
          0.4 * Math.cos(hip.rotation.x + knee.rotation.x)
        );
      });
      this.body.position.y =
        Math.max(-0.16, Math.max(...drops) - 0.82) +
        (speed < 0.07 ? Math.sin(this.mixer.time * 1.7) * 0.002 : 0);
    }
    this.model.updateWorldMatrix(true, true);
    this.arms.forEach((arm, i) => {
      if (!arm.shoulder) return;
      if (
        targets &&
        this.pushing &&
        !(holding && i === 1) &&
        !(picking && i === 1)
      ) {
        this.solveArm(arm, targets[i], dt);
        return;
      }
      const blend = 1 - Math.exp(-dt * 12),
        carry = (holding && i === 1) || (picking && i === 1);
      arm.shoulder.rotation.x = MathUtils.lerp(
        arm.shoulder.rotation.x,
        carry
          ? -0.25
          : Math.sin(this.phase + (i ? Math.PI : 0)) *
              Math.min(0.4, speed * 0.1),
        blend,
      );
      arm.shoulder.rotation.z = MathUtils.lerp(
        arm.shoulder.rotation.z,
        0,
        blend,
      );
      if (arm.elbow)
        arm.elbow.rotation.x = MathUtils.lerp(
          arm.elbow.rotation.x,
          carry ? -1.3 : -0.12,
          blend,
        );
      if (arm.wrist) arm.wrist.rotation.x = carry ? 0.3 : 0;
    });
  }
  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
  }
}
