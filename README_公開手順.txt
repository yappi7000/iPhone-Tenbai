【iPhone買取チェッカー 公開版】

1. GitHubにこのフォルダ内のファイルをアップロード
2. RenderでNew > Web Serviceを選択
3. GitHubリポジトリを接続
4. Runtime: Python
5. Build Command: 空欄
6. Start Command: python server.py
7. Environment Variablesに以下を登録
   Key: LITE_API_KEY
   Value: 買取ナビLiteのAPIキー
8. Deployを実行

注意：APIキーはindex.htmlやGitHubに書かないでください。
APIキーの公開利用がAPI提供元の規約・上限に適合することを確認してください。
