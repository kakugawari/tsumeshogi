# 駒の字のフォント

盤と駒パレットに描く駒の文字は **Shippori Mincho Bold** を使っています。
端末に入っているフォントに左右されず、オフラインでも同じ見た目になるように、
駒に使う14文字（歩香桂銀金角飛玉と杏圭全馬龍）だけを切り出して
`styles.css` の `@font-face` に woff2 として埋め込んであります（3.7KB）。

これは `kakugawari/kifu` (棋譜ノート) で作った埋め込みフォントと同じもので、
姉妹アプリ同士で駒の見た目をそろえるために再利用しています。

- 書体: Shippori Mincho — https://github.com/fontdasu/ShipporiMincho
- Copyright 2021 The Shippori Mincho Project Authors
- ライセンス: SIL Open Font License 1.1（全文は `OFL.txt`）
- Reserved Font Name の指定はありません
- フォントの切り出し方 (`fonttools` での subset 手順) は
  `kakugawari/kifu` の `tools/make-koma-font.sh` を参照してください
  (このリポジトリでは作りなおすスクリプトまでは持たず、埋め込み済みの
  ものをそのまま使っています)。

成り駒が「成香」ではなく「杏」のような一文字表記なのは、この埋め込み
フォントが「成」の字を含んでいない (14文字に入っていない)ためです。
実際の駒札の略字と同じ表記なので、表示としても自然です。
