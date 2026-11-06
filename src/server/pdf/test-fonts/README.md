# Test fonts

`latin-only.ttf` and `latin-only.otf` are used by the PDF tests. They hold ASCII only, so they prove the fallback to IBM Plex. Both are cut from the bundled IBM Plex Sans Arabic with `fontTools` and renamed Fixture Latin, because "Plex" is a reserved font name. The OTF has the same outlines in CFF form. `OFL-LICENSE.txt` applies to both.
