import time
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Rectangle, Arc
from nba_api.stats.endpoints import shotchartdetail, commonallplayers
from nba_api.stats.static import players

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import CHARTS_DIR, DATA_PROCESSED, ensure_project_dirs

CONFIG = [
    ("Stephen Curry", "00", "2024-25", 237.5, 220.0),  # NBA
    ("Paige Bueckers", "10", "2025", 221.5, 216.5),    # WNBA
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
    "Accept": "application/json, text/plain, */*",
}


def with_retry(fn, retries=4):
    """ลองเรียกซ้ำเมื่อพลาด โดยรอนานขึ้นเรื่อย ๆ"""
    for i in range(retries):
        try:
            return fn()
        except Exception as e:
            print(f"ครั้งที่ {i + 1} พลาด: {e}")
            time.sleep(5 * (i + 1))
    raise RuntimeError("ดึงข้อมูลไม่สำเร็จ น่าจะโดนบล็อก IP ลองรันบนเครื่องตัวเอง")


def get_player_id(name, league_id, season):
    """หา id ของนักกีฬา (WNBA ไม่อยู่ในรายชื่อ static เลยต้องค้นผ่าน API)"""
    if league_id == "00":
        return players.find_players_by_full_name(name)[0]["id"]
    df = with_retry(lambda: commonallplayers.CommonAllPlayers(
        league_id=league_id, season=season, is_only_current_season=0,
        headers=HEADERS, timeout=60,
    ).get_data_frames()[0])
    row = df[df["DISPLAY_FIRST_LAST"].str.lower() == name.lower()]
    if row.empty:
        raise ValueError(f"หา {name} ไม่เจอใน league {league_id}")
    return int(row.iloc[0]["PERSON_ID"])


def get_shots(player_id, season, league_id):
    """ดึงทุกช็อตที่ยิง (FGA) ของฤดูกาลนั้น"""
    return with_retry(lambda: shotchartdetail.ShotChartDetail(
        team_id=0,
        player_id=player_id,
        season_nullable=season,
        season_type_all_star="Regular Season",
        league_id=league_id,
        context_measure_simple="FGA",
        headers=HEADERS,
        timeout=60,
    ).get_data_frames()[0])


def load_shots(name, league, season):
    """โหลดจากไฟล์ CSV ถ้ามีแล้ว ไม่งั้นดึงจาก API แล้วเซฟไว้"""
    ensure_project_dirs()
    fname = DATA_PROCESSED / f"{name.replace(' ', '_').lower()}_{season}.csv"
    if fname.exists():
        print(f"โหลดจากไฟล์ที่เซฟไว้: {fname}")
        return pd.read_csv(fname)
    pid = get_player_id(name, league, season)
    df = get_shots(pid, season, league)
    df.to_csv(fname, index=False)
    return df


def draw_court(ax, three_r, corner_x, color="black", lw=1.5):
    """วาดคอร์ทครึ่งสนาม (ห่วงอยู่ที่ 0,0)"""
    kw = dict(linewidth=lw, color=color, fill=False)
    ax.add_patch(Circle((0, 0), 7.5, **kw))                       # ห่วง
    ax.add_patch(Rectangle((-30, -7.5), 60, -1, **kw))            # แบ็คบอร์ด
    ax.add_patch(Rectangle((-80, -47.5), 160, 190, **kw))         # เลนใหญ่
    ax.add_patch(Rectangle((-60, -47.5), 120, 190, **kw))         # เลนใน
    ax.add_patch(Arc((0, 142.5), 120, 120, theta1=0, theta2=180, **kw))   # โค้งโทษ บน
    ax.add_patch(Arc((0, 142.5), 120, 120, theta1=180, theta2=360,
                     linestyle="dashed", **kw))                   # โค้งโทษ ล่าง
    ax.add_patch(Arc((0, 0), 80, 80, theta1=0, theta2=180, **kw)) # restricted area

    # เส้น 3 แต้ม: เส้นตรงที่มุม + โค้ง
    y_corner = np.sqrt(three_r ** 2 - corner_x ** 2)
    ax.plot([-corner_x, -corner_x], [-47.5, y_corner], color=color, lw=lw)
    ax.plot([corner_x, corner_x], [-47.5, y_corner], color=color, lw=lw)
    theta = np.degrees(np.arccos(corner_x / three_r))
    ax.add_patch(Arc((0, 0), 2 * three_r, 2 * three_r,
                     theta1=theta, theta2=180 - theta, **kw))

    ax.add_patch(Rectangle((-250, -47.5), 500, 470, **kw))        # เส้นขอบสนาม
    ax.set_xlim(-250, 250)
    ax.set_ylim(-50, 420)
    ax.set_aspect("equal")
    ax.axis("off")


def plot_shots(ax, df, title):
    made = df[df["SHOT_MADE_FLAG"] == 1]
    miss = df[df["SHOT_MADE_FLAG"] == 0]
    ax.scatter(miss["LOC_X"], miss["LOC_Y"], c="red", marker="x", s=12, alpha=0.5, label="Miss")
    ax.scatter(made["LOC_X"], made["LOC_Y"], c="green", marker="o", s=12, alpha=0.6, label="Made")
    fg = len(made) / len(df) * 100 if len(df) else 0
    ax.set_title(f"{title}\n{len(made)}/{len(df)} shots  (FG {fg:.1f}%)")
    ax.legend(loc="upper right", fontsize=8)


def main():
    ensure_project_dirs()
    fig, axes = plt.subplots(1, len(CONFIG), figsize=(6 * len(CONFIG), 6.5), squeeze=False)
    for ax, (name, league, season, three_r, corner_x) in zip(axes[0], CONFIG):
        df = load_shots(name, league, season)
        print(f"{name} ({season}): {len(df)} shots")
        print(df[["LOC_X", "LOC_Y", "SHOT_DISTANCE", "SHOT_ZONE_BASIC", "SHOT_MADE_FLAG"]].head(), "\n")
        draw_court(ax, three_r, corner_x)
        plot_shots(ax, df, f"{name} - {season}")
    plt.tight_layout()
    plt.savefig(CHARTS_DIR / "shot_charts.png", dpi=150)
    plt.show()


if __name__ == "__main__":
    main()
