import random
import time

def rastgele_hamle():
    """Rastgele bir Rubik's Cube hareketi döndürür"""
    yuzler = ["U", "D", "L", "R", "F", "B"]
    yonler = ["", "'", "2"]  # normal, ters, çift dönüş
    return random.choice(yuzler) + random.choice(yonler)

def kupu_coz(adim_sayisi):
    print("🧩 Zeka Küpü Simülasyonu Başlatıldı!")
    print(f"🔄 Karışıklık derecesi: {adim_sayisi} hamle\n")
    print("📘 Çözüm başlıyor...\n")

    for i in range(1, adim_sayisi + 1):
        hamle = rastgele_hamle()
        print(f"{i}. adım → {hamle}")
        time.sleep(0.3)  # adımlar arası bekleme (isteğe bağlı)
    
    print("\n🎉 Küp başarıyla çözüldü!")
    print("🧠 Harika iş çıkardın!")

def main():
    print("=== Zeka Küpü Çözüm Simülasyonu ===")
    try:
        zorluk = int(input("Karışıklık derecesi (1-20): "))
        if 1 <= zorluk <= 20:
            kupu_coz(zorluk)
        else:
            print("⚠️ Lütfen 1 ile 20 arasında bir sayı gir.")
    except ValueError:
        print("⚠️ Geçerli bir sayı girmen gerekiyor.")

if __name__ == "__main__":
    main()
