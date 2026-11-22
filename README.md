# 長洲飛行隊｜香港巡航

在瀏覽器運行的 WebGL 無人機遊戲（HTML／JavaScript）。可在手機或電腦以 HTTPS 開啟下面網址試玩：

**https://hkrgb.github.io/hk-drone-flight/**

版本：**r12-20261122-1155**。全程最低離地高度 200 米。全港地圖按位置分塊載入，不需一次下載全境。模型與地圖改為開始後逐步載入；等候時顯示計數、參考棋盤及重試按鈕，棋盤並非真實海陸。網絡圖磚失敗時會嘗試載入長洲離線地圖。

## 操作

- 鍵盤：WASD 平移，Q / E 轉向，空白鍵升高，Shift 下降，C 切換視角，R 重飛
- 手機：使用畫面左下／右下按鈕；亦可在網址加上 `?quality=low` 使用省資源模式
- 出發點選單可傳送到全港多個地點（傳送後同樣不少於離地 200 米）
- 長洲碼頭 +「開始任務」：七站巡航（10 分鐘電量）：碼頭出發 → 北帝廟 → 北眺亭 → 東灣 → 南氹 → 西灣 → 返回碼頭
- 其他出發點或「自由飛行」：沒有全港任務

建議先試：長洲碼頭、中環海濱、大帽山、南丫島榕樹灣。

除錯參數（一般遊玩不需要）：在網址加上 `?debug=1`。若右上角出現紅色版本列，代表偵測到錯誤，列上會有原因；這不是「還在等地圖」。本站是靜態網頁，沒有後端錯誤紀錄。

## 限制

沒有立體樓宇；市區是航拍貼在地面高程上。原模型四組螺旋槳會在飛行時轉動，第一視角隱藏整個機身。巡航任務只在長洲碼頭出發後進行。全港山形比長洲內嵌 5 米高程粗糙。

## 資料來源與授權

- 全港航拍：地政總署 Imagery Map API（CSDI）。畫面須顯示地政總署標誌及 “Aerial Photograph from Lands Department”。
- 任務航點座標：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)，並對照[地政總署長洲地圖](https://www.landsd.gov.hk/doc/en/mapping/ehkg/MapPages/GeoPDF/IS04_CheungChau.pdf)。
- 全港高程：AWS / Mapzen Terrain Tiles（Terrarium）。香港地區主要為 SRTM／GMTED，courtesy of the U.S. Geological Survey。
- 長洲精細高程及離線航拍：地政總署 5 米 DTM 及遊戲內嵌航拍圖（離線備用）。
- 無人機模型：Sketchfab “[non-military consumer UAV drone](https://sketchfab.com/3d-models/non-military-consumer-uav-drone-7558fc3a77d4412dad2a02d9d7c3fbb7)” by [FamousUnityHubSoldier](https://sketchfab.com/FamousUnityHubSoldier)，[Sketchfab Standard](https://sketchfab.com/licenses) 授權。詳細條款見 [`3d model/license.txt`](3d%20model/license.txt)。公開倉庫只包含遊戲運行所需貼圖與轉換後的模型資料，以及授權與出處說明；不含原始 `.gltf` / `.bin` 獨立模型檔。

本倉庫只發布可在瀏覽器遊玩的靜態網頁，沒有本機啟動腳本或除錯伺服器。

## r10 地圖修正

修正航拍上下方向、粗細地形互相遮蓋及高程更新，移除遮住航拍的舊假碼頭平台；保留任務圓環、無人機模型及最低離地 200 米。已在瀏覽器核對長洲及中環操作。航拍低空仍偏模糊，部分區域仍有拼接感；沒有立體樓宇。

## r11 手機與長洲更新

飛行按鈕加入防選字／長按複製處理，保留原生下拉選單；長洲使用附近分區載入的 z17／z18 航拍細節，其他地區維持 z15。瀏覽器及 Chrome 手機模擬已檢查；真手機及雙指實機測試仍待確認。高清細節仍受網速、手機效能及來源影像影響。

## r12 啟動與螺旋槳更新

開始前不再下載大型離線高程或模型；原模型在入場後背景載入。手機自動限制圖磚併發、每幀網格建立量及紋理負載，長洲保留 z17 細節。原模型槳葉分組旋轉，沒有額外重疊的靜止槳。

Chrome 手機模擬及 Slow3G／停用快取測試可開始、操控並於網絡恢復後在同一局顯示地圖和模型；真 Android 手機仍未驗證，橫屏開始按鈕位置及重試按鈕效果亦未完成瀏覽器隔離驗收。慢網絡仍需等候圖資，不能保證高清即時顯示。
