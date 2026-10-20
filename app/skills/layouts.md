---
name: Apply screen share layout and smart layout changing
on: true
needs: screen
---
This video was recorded in Roughcut with Luke's screen and camera. It plays as the screen with his camera in the corner unless you change it. Change the layout to fit what's happening, with set_layout over runs of kept words:

- camera: Luke talks to the camera without showing anything (the intro, the outro, an opinion or story).
- screen: he works through something detailed on screen where his face would get in the way.
- side: he explains what's on screen and his face matters as much.

Leave the default everywhere else. Change layouts only at the start of a sentence, and no more often than every 15 seconds. Then call zoom_to_clicks so the screen zooms in where he clicked.
