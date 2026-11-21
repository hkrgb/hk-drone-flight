# 長洲飛行隊｜香港巡航

在瀏覽器運行的 WebGL 無人機遊戲（HTML／JavaScript）。可在手機或電腦以 HTTPS 開啟下面網址試玩：

**https://hkrgb.github.io/hk-drone-flight/**

版本：**r10-20261122-0110**。全程最低離地高度 200 米。全港地圖按位置分塊載入，不需一次下載全境。圖磚未到也可先開始；網絡圖磚失敗時會改用長洲離線地圖並在畫面標示。

## 操作

- 鍵盤：WASD 平移，Q / E 轉向，空白鍵升高，Shift 下降，C 切換視角，R 重飛
- 手機：使用畫面左下／右下按鈕；直向與橫向都可操作
- 出發點選單可傳送到全港多個地點（傳送後同樣不少於離地 200 米）
- 長洲碼頭 +「開始任務」：離島巡航（約 240 秒電量）
- 其他出發點或「自由飛行」：沒有全港任務

建議先試：長洲碼頭、中環海濱、大帽山、南丫島榕樹灣。

除錯參數（一般遊玩不需要）：在網址加上 `?debug=1`。若右上角出現紅色版本列，代表偵測到錯誤，列上會有原因；這不是「還在等地圖」。本站是靜態網頁，沒有後端錯誤紀錄。

## 限制

沒有立體樓宇；市區是航拍貼在地面高程上。螺旋槳不會轉動。巡航任務只在長洲碼頭出發後進行。全港山形比長洲內嵌 5 米高程粗糙。

## 資料來源與授權

- 全港航拍：地政總署 Imagery Map API（CSDI）。畫面須顯示地政總署標誌及 “Aerial Photograph from Lands Department”。
- 全港高程：AWS / Mapzen Terrain Tiles（Terrarium）。香港地區主要為 SRTM／GMTED，courtesy of the U.S. Geological Survey。
- 長洲精細高程及離線航拍：地政總署 5 米 DTM 及遊戲內嵌航拍圖（離線備用）。
- 無人機模型：Sketchfab “[non-military consumer UAV drone](https://sketchfab.com/3d-models/non-military-consumer-uav-drone-7558fc3a77d4412dad2a02d9d7c3fbb7)” by [FamousUnityHubSoldier](https://sketchfab.com/FamousUnityHubSoldier)，[Sketchfab Standard](https://sketchfab.com/licenses) 授權。詳細條款見 [`3d model/license.txt`](3d%20model/license.txt)。公開倉庫只包含遊戲運行所需貼圖與轉換後的模型資料，以及授權與出處說明；不含原始 `.gltf` / `.bin` 獨立模型檔。

本倉庫只發布可在瀏覽器遊玩的靜態網頁，沒有本機啟動腳本或除錯伺服器。

## r10 地圖修正

修正航拍上下方向、粗細地形互相遮蓋及高程更新，移除遮住航拍的舊假碼頭平台；保留任務圓環、無人機模型及最低離地 200 米。已在瀏覽器核對長洲及中環操作。航拍低空仍偏模糊，部分區域仍有拼接感；沒有立體樓宇。
