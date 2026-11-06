"""Create a polished, poster-style comparison of Curry and Bueckers' 2025 shots."""

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.patches import Arc, Circle, Rectangle
from paths import CHARTS_DIR, DATA_PROCESSED, ensure_project_dirs


OUT = CHARTS_DIR / "shot_chart_poster.png"

BG = "#080D15"
PANEL = "#111923"
PANEL_ALT = "#0D151F"
WHITE = "#F5F4EF"
MUTED = "#A1ACB9"
COURT = "#A8B3BE"
MISS = "#FF657A"

PLAYERS = [
    {
        "name": "STEPHEN CURRY",
        "team": "GOLDEN STATE  /  NBA",
        "season": "2024—25",
        "file": "stephen_curry_2025.csv",
        "accent": "#FFC857",
        "three_r": 237.5,
        "corner_x": 220.0,
        "tag": "THE RANGE",
    },
    {
        "name": "PAIGE BUECKERS",
        "team": "DALLAS  /  WNBA",
        "season": "2025",
        "file": "paige_bueckers_2025.csv",
        "accent": "#65D6C5",
        "three_r": 221.5,
        "corner_x": 216.5,
        "tag": "THE FLOOR GENERAL",
    },
]


def draw_court(ax, three_r, corner_x, color=COURT):
    """Draw a half court in the same 0.1-foot coordinate system as the shots."""
    kw = {"fill": False, "edgecolor": color, "linewidth": 1.15, "alpha": 0.58}
    ax.add_patch(Circle((0, 0), 7.5, **kw))
    ax.add_patch(Rectangle((-30, -7.5), 60, -1, **kw))
    ax.add_patch(Rectangle((-80, -47.5), 160, 190, **kw))
    ax.add_patch(Rectangle((-60, -47.5), 120, 190, **kw))
    ax.add_patch(Arc((0, 142.5), 120, 120, theta1=0, theta2=180, **kw))
    ax.add_patch(Arc((0, 142.5), 120, 120, theta1=180, theta2=360,
                     linestyle="dashed", **kw))
    ax.add_patch(Arc((0, 0), 80, 80, theta1=0, theta2=180, **kw))

    y_corner = np.sqrt(three_r**2 - corner_x**2)
    ax.plot([-corner_x, -corner_x], [-47.5, y_corner], color=color, lw=1.15, alpha=0.58)
    ax.plot([corner_x, corner_x], [-47.5, y_corner], color=color, lw=1.15, alpha=0.58)
    theta = np.degrees(np.arccos(corner_x / three_r))
    ax.add_patch(Arc((0, 0), 2 * three_r, 2 * three_r,
                     theta1=theta, theta2=180 - theta, **kw))
    ax.add_patch(Rectangle((-250, -47.5), 500, 470, **kw))

    ax.set_xlim(-250, 250)
    ax.set_ylim(-50, 420)
    ax.set_aspect("equal")
    ax.set_facecolor(PANEL_ALT)
    ax.axis("off")


def player_panel(fig, player, rect):
    df = pd.read_csv(DATA_PROCESSED / player["file"])
    df = df.dropna(subset=["LOC_X", "LOC_Y", "SHOT_MADE_FLAG"])
    made = df[df["SHOT_MADE_FLAG"] == 1]
    missed = df[df["SHOT_MADE_FLAG"] == 0]
    fga, fgm = len(df), len(made)
    fg = (100 * fgm / fga) if fga else 0
    points = pd.to_numeric(df.get("score_value"), errors="coerce").fillna(0).sum()
    pps = points / fga if fga else 0

    x, y, w, h = rect
    # Panel and accent rails
    fig.patches.append(Rectangle((x, y), w, h, transform=fig.transFigure,
                                 facecolor=PANEL, edgecolor="#26313E", linewidth=0.8,
                                 zorder=-1))
    fig.patches.append(Rectangle((x, y + h - 0.012), w, 0.012,
                                 transform=fig.transFigure, facecolor=player["accent"],
                                 edgecolor="none", zorder=2))

    # Card header
    fig.text(x + 0.028, y + h - 0.065, player["tag"], color=player["accent"],
             fontsize=9, fontweight="bold", va="center")
    fig.text(x + 0.028, y + h - 0.12, player["name"], color=WHITE,
             fontsize=19, fontweight="bold", va="center")
    fig.text(x + 0.028, y + h - 0.16, f'{player["team"]}   •   {player["season"]}',
             color=MUTED, fontsize=8, fontweight="bold", va="center")
    fig.text(x + w - 0.028, y + h - 0.11, f"{fg:.1f}%", color=player["accent"],
             fontsize=27, fontweight="bold", ha="right", va="center")
    fig.text(x + w - 0.028, y + h - 0.155, "FIELD GOAL %", color=MUTED,
             fontsize=8, fontweight="bold", ha="right", va="center")

    # Shot map
    ax = fig.add_axes([x + 0.035, y + 0.125, w - 0.07, h - 0.34])
    draw_court(ax, player["three_r"], player["corner_x"])
    # Soft glow keeps the made shots visible without the old solid-wall effect.
    ax.scatter(made["LOC_X"], made["LOC_Y"], s=42, c=player["accent"],
               alpha=0.075, linewidths=0, zorder=2)
    ax.scatter(missed["LOC_X"], missed["LOC_Y"], s=34, c=MISS,
               alpha=0.055, linewidths=0, zorder=2)
    ax.scatter(missed["LOC_X"], missed["LOC_Y"], s=14, c=MISS,
               marker="x", alpha=0.68, linewidths=0.8, zorder=3)
    ax.scatter(made["LOC_X"], made["LOC_Y"], s=13, c=player["accent"],
               marker="o", alpha=0.78, edgecolors=BG, linewidths=0.25, zorder=4)

    # Legend chips sit in the plot instead of covering the title.
    ax.scatter([], [], s=22, c=player["accent"], marker="o", label="MADE")
    ax.scatter([], [], s=22, c=MISS, marker="x", label="MISSED")
    legend = ax.legend(loc="upper right", frameon=True, facecolor=PANEL,
                       edgecolor="#344252", labelcolor=WHITE, fontsize=7,
                       ncol=2, borderpad=0.45, handletextpad=0.5,
                       columnspacing=1.0)
    legend.get_frame().set_alpha(0.94)

    # Footer metrics
    footer = fig.add_axes([x + 0.03, y + 0.025, w - 0.06, 0.08], frameon=False)
    footer.set_xlim(0, 1)
    footer.set_ylim(0, 1)
    footer.axis("off")
    for sx, value, label in [
        (0.00, f"{fgm:,}/{fga:,}", "MADE / ATTEMPTED"),
        (0.36, f"{fg:.1f}%", "FG ACCURACY"),
        (0.70, f"{pps:.2f}", "POINTS / SHOT"),
    ]:
        footer.text(sx, 0.63, value, color=WHITE, fontsize=15,
                    fontweight="bold", ha="left", va="center")
        footer.text(sx, 0.18, label, color=MUTED, fontsize=7,
                    fontweight="bold", ha="left", va="center")
    footer.plot([0, 1], [0.98, 0.98], color="#344252", lw=0.8)


def main():
    ensure_project_dirs()
    plt.rcParams.update({
        "figure.facecolor": BG,
        "savefig.facecolor": BG,
        "font.family": "DejaVu Sans",
        "text.color": WHITE,
    })
    fig = plt.figure(figsize=(16, 10), dpi=180)
    fig.patch.set_facecolor(BG)

    # Oversized editorial masthead with a bright marker.
    fig.text(0.055, 0.945, "COURTSIDE  /  DATA SERIES 01", color="#A1ACB9",
             fontsize=9, fontweight="bold", va="center")
    fig.text(0.055, 0.875, "THE SHOT", color=WHITE, fontsize=39,
             fontweight="bold", va="center")
    fig.text(0.055, 0.815, "PROFILE", color="#FFC857", fontsize=39,
             fontweight="bold", va="center")
    fig.text(0.485, 0.855, "Two scorers. Two leagues.\nA whole lot of range.",
             color=MUTED, fontsize=13, linespacing=1.45, va="center")
    fig.text(0.945, 0.91, "2025", color="#24313E", fontsize=37,
             fontweight="bold", ha="right", va="center")
    fig.text(0.945, 0.86, "SHOT MAPS", color="#A1ACB9", fontsize=8,
             fontweight="bold", ha="right", va="center")

    # Divider and tiny accent ticks give the canvas a designed rhythm.
    fig.lines.append(plt.Line2D([0.055, 0.945], [0.765, 0.765],
                                transform=fig.transFigure, color="#26313E", lw=1))
    fig.lines.append(plt.Line2D([0.055, 0.14], [0.765, 0.765],
                                transform=fig.transFigure, color="#FFC857", lw=3))

    player_panel(fig, PLAYERS[0], (0.055, 0.12, 0.435, 0.61))
    player_panel(fig, PLAYERS[1], (0.51, 0.12, 0.435, 0.61))

    fig.text(0.055, 0.065, "MADE", color="#F5F4EF", fontsize=8,
             fontweight="bold", va="center")
    fig.text(0.095, 0.065, "shots glow in each player's accent", color=MUTED,
             fontsize=8, va="center")
    fig.text(0.945, 0.065, "SOURCE  ESPN PLAY-BY-PLAY  •  REGULAR-SEASON FIELD GOALS",
             color="#788594", fontsize=7, fontweight="bold", ha="right", va="center")

    fig.savefig(OUT, dpi=180, bbox_inches="tight", pad_inches=0.18)
    print(f"Saved poster: {OUT}")


if __name__ == "__main__":
    main()
