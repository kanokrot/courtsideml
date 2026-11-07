"""
Shot chart โดยใช้ข้อมูลช็อตจาก sportsdataverse (ESPN) แทน stats.nba.com
ติดตั้งก่อน:  pip install requests pandas pyarrow matplotlib numpy
"""
from pathlib import Path
import sys

import numpy as np
import pandas as pd
import requests
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Rectangle, Arc
sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import CHARTS_DIR, DATA_PROCESSED, DATA_RAW, ensure_project_dirs

# ---------- ตั้งค่า (แก้ตรงนี้ได้) ----------
# (ชื่อ ตามที่ ESPN เขียน, release tag, ปีที่ฤดูกาลจบ, รัศมีเส้น 3 แต้ม, ระยะเส้น 3 แต้มมุมคอร์ท)
# ESPN ใช้ปีที่ฤดูกาลจบ: NBA 2024-25 = 2025, WNBA 2025 = 2025
# หน่วยที่ใช้วาดคอร์ท = 0.1 ฟุต, ห่วงอยู่ที่ (0, 0)
CONFIG = [
    ("Stephen Curry", "espn_nba_shots", 2025, 237.5, 220.0),    # NBA
    ("Paige Bueckers", "espn_wnba_shots", 2025, 221.5, 216.5),  # WNBA
]

URL = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download/{tag}/shots_{season}.parquet"


def load_season(tag, season):
    """โหลดช็อตทั้งลีกของฤดูกาลนั้น (เซฟไว้ในเครื่อง โหลดครั้งเดียว)"""
    ensure_project_dirs()
    fname = DATA_RAW / f"{tag}_{season}.parquet"
    if not fname.exists():
        print(f"กำลังโหลด {tag} {season} ...")
        r = requests.get(URL.format(tag=tag, season=season), timeout=120)
        r.raise_for_status()
        with open(fname, "wb") as f:
            f.write(r.content)
    return pd.read_parquet(fname)


def load_shots(name, tag, season):
    league = load_season(tag, season)
    df = league[league["athlete_name_1"].fillna("").str.lower() == name.lower()].copy()
    if df.empty:
        last = name.split()[-1].lower()
        similar = league[league["athlete_name_1"].fillna("").str.lower().str.contains(last)]
        print(f"หา {name} ไม่เจอ ชื่อที่ใกล้เคียง:", similar["athlete_name_1"].unique()[:10])
        raise ValueError(f"ไม่เจอ {name} ใน {tag} {season}")

    # ตัดลูกโทษออก และตัดแถวที่พิกัดว่าง/ผิดปกติ
    df = df[~df["type_text"].fillna("").str.startswith("Free Throw")]
    df = df[df["coordinate_x_raw"].between(0, 50) & df["coordinate_y_raw"].between(0, 47)]

    # raw: x = ซ้าย-ขวา (ห่วงอยู่ที่ x=25), y = ระยะห่างจากห่วงไปข้างหน้า (หน่วยฟุต)
    df["LOC_X"] = (df["coordinate_x_raw"] - 25) * 10
    df["LOC_Y"] = df["coordinate_y_raw"] * 10
    df["SHOT_DISTANCE"] = np.sqrt(df["LOC_X"] ** 2 + df["LOC_Y"] ** 2) / 10
    df["SHOT_MADE_FLAG"] = df["scoring_play"].fillna(False).astype(int)

    ensure_project_dirs()
    df.to_csv(DATA_PROCESSED / f"{name.replace(' ', '_').lower()}_{season}.csv", index=False)
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
    for ax, (name, tag, season, three_r, corner_x) in zip(axes[0], CONFIG):
        df = load_shots(name, tag, season)
        print(f"{name} ({season}): {len(df)} shots")
        print(df[["LOC_X", "LOC_Y", "SHOT_DISTANCE", "type_text", "SHOT_MADE_FLAG"]].head(), "\n")
        draw_court(ax, three_r, corner_x)
        plot_shots(ax, df, f"{name} - {season}")
    plt.tight_layout()
    plt.savefig(CHARTS_DIR / "shot_charts.png", dpi=150)
    plt.show()


if __name__ == "__main__":
    main()
