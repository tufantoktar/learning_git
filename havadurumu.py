import requests

def hava_durumu_getir(sehir, api_key):
    url = f"https://api.openweathermap.org/data/2.5/weather?q={sehir}&appid={api_key}&lang=tr&units=metric"
    response = requests.get(url)
    
    if response.status_code == 200:
        veri = response.json()
        isim = veri["name"]
        sicaklik = veri["main"]["temp"]
        durum = veri["weather"][0]["description"].capitalize()
        print(f"🌍 Şehir: {isim}")
        print(f"🌡️ Sıcaklık: {sicaklik}°C")
        print(f"☁️ Hava Durumu: {durum}")
    else:
        print("⚠️ Şehir bulunamadı veya API hatası!")

def main():
    print("=== Hava Durumu Uygulaması ===")
    sehir = input("Şehir adını gir: ")
    api_key = "BURAYA_API_KEYİNİ_YAZ"  # OpenWeatherMap API anahtarını buraya ekle
    hava_durumu_getir(sehir, api_key)

if __name__ == "__main__":
    main()
