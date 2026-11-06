"""
สคริปต์สำรวจข้อมูลช็อตจาก sportsdataverse (โฮสต์บน GitHub)
ติดตั้งก่อน:  pip install requests pandas pyarrow
"""
import requests
import pandas as pd
from paths import DATA_RAW, ensure_project_dirs

# (release tag, ปีที่จะหาในชื่อไฟล์)
# ESPN มักใช้ปีที่ฤดูกาลจบ เช่น NBA 2024-25 = 2025
TARGETS = {
    "wnba": ("espn_wnba_shots", "2025"),
    "nba": ("espn_nba_shots", "2025"),
}

API = "https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/tags/{tag}"


def explore(label, tag, year):
    print(f"\n===== {label} ({tag}) =====")
    r = requests.get(API.format(tag=tag), timeout=60)
    r.raise_for_status()
    assets = r.json()["assets"]
    names = [a["name"] for a in assets]
    print("ไฟล์ทั้งหมดใน release นี้:", names)

    match = [a for a in assets if year in a["name"] and a["name"].endswith(".parquet")]
    if not match:
        print(f"ไม่เจอไฟล์ .parquet ที่มี {year} ในชื่อ -> ส่งรายชื่อไฟล์ข้างบนมาให้ดู")
        return
    asset = match[0]
    print("กำลังโหลด:", asset["name"])
    data = requests.get(asset["browser_download_url"], timeout=120)
    data.raise_for_status()
    ensure_project_dirs()
    fname = DATA_RAW / f"{label}_{asset['name']}"
    with open(fname, "wb") as f:
        f.write(data.content)

    df = pd.read_parquet(fname)
    print("จำนวนแถว:", len(df))
    print("คอลัมน์:", list(df.columns))
    print(df.head(5).to_string())


def main():
    for label, (tag, year) in TARGETS.items():
        try:
            explore(label, tag, year)
        except Exception as e:
            print(f"{label} พลาด: {e}")


if __name__ == "__main__":
    main()
