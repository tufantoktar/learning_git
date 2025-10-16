def yuzde_degisim(eski, yeni):
    try:
        eski = float(eski)
        yeni = float(yeni)
        fark = yeni - eski
        yuzde = (fark / eski) * 100

        if yuzde > 0:
            print(f"📈 Artış: %{yuzde:.2f}")
        elif yuzde < 0:
            print(f"📉 Düşüş: %{abs(yuzde):.2f}")
        else:
            print("➡️ Hiç değişim yok.")
    except ValueError:
        print("⚠️ Lütfen geçerli bir sayı gir!")

def main():
    print("=== 🧮 Yüzde Artış / Düşüş Hesaplayıcı ===")
    eski = input("Eski değeri gir: ")
    yeni = input("Yen
