import random

# Anahtar kelimeler ve cevaplar
cevaplar = {
    "merhaba": ["Merhaba! Nasılsın?", "Selam! 😊"],
    "nasılsın": ["İyiyim, sen nasılsın?", "Harikayım, teşekkürler!"],
    "hava": ["Dışarısı güzel görünüyor!", "Sanırım biraz yağmur yağacak."],
    "teşekkür": ["Rica ederim!", "Ne demek 😊"],
    "görüşürüz": ["Görüşürüz! Kendine iyi bak!", "Hoşça kal!"]
}

# Genel cevaplar
genel_cevaplar = ["Hmm, bunu anlamadım 🤔", "Başka bir şey söyleyebilir misin?", "Anlamadım ama öğrenebilirim!"]

def sohbet():
    print("=== Mini Sohbet Botu ===")
    print("Çıkmak için 'çık' yazabilirsiniz.\n")

    while True:
        kullanici = input("Sen: ").lower()
        if kullanici == "çık":
            print("Bot: Görüşürüz! 👋")
            break
        
        cevap_verildi = False
        for anahtar, cevap_listesi in cevaplar.items():
            if anahtar in kullanici:
                print("Bot:", random.choice(cevap_listesi))
                cevap_verildi = True
                break
        
        if not cevap_verildi:
            print("Bot:", random.choice(genel_cevap_
