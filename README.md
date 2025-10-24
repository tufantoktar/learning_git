# Rubik’s Cube (3×3) Simülasyonu

Tarayıcıda çalışan, **Vanilla JavaScript** ile yazılmış basit bir **Rubik küp simülasyonu**. 2D net gösterimi, standart hamleler (U, D, L, R, F, B), karıştırma, zamanlayıcı ve hamle geçmişi içerir.

## ✨ Özellikler
- 2D net çizimi (U, D, F, B, L, R yüzleri)
- Standart hamleler: `U, D, L, R, F, B` ve `', 2` varyantları (örn. `U'`, `R2`)
- Karıştırma (varsayılan 25 hamle)
- Geri al / İleri al (Undo/Redo)
- Zamanlayıcı ve hamle sayacı
- Klavye kısayolları: `U D L R F B` (Shift: prime `'`, `2`: çift hamle)

## 🗂️ Yapı
```
rubiks-cube-sim/
├─ index.html
├─ styles.css
├─ app.js
└─ README.md
```

## 🚀 Çalıştırma
1. Bu klasörü indirip aç.
2. `index.html` dosyasını tarayıcıda aç (ya da bir statik server ile servis et).

> Python ile basit bir server:
```bash
python -m http.server 8080
# http://localhost:8080
```

## 🎮 Kullanım
- Üstteki butonlarla ya da klavye ile hamle yap.
- **Karıştır (25)** ile rastgele bir karışım uygula ve süreyi başlat.
- **Sıfırla** ile çözümlü hale dön.
- **Geri Al / İleri Al** ile hamle geçmişinde dolaş.

## 🧠 Notlar
- Bu proje görsel bir simülasyondur; otomatik çözümleyici içermez.
- Hamle mantığı sticker seviyesinde uygulanmıştır (54 parça).

## 📄 Lisans
MIT
