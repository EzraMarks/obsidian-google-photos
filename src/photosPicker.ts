import { App, Editor, MarkdownView, Notice } from "obsidian";
import GooglePhotos from "./main";

declare global {
  interface Window {
    google: {
      photos: {
        picker: {
          PickerBuilder: any;
          Feature: any;
          ViewId: any;
        };
      };
    };
    gapi: {
      load: (
        api: string,
        options: { callback: () => void; onerror?: () => void } | (() => void)
      ) => void;
      client: {
        init: (config: {
          apiKey: string;
          discoveryDocs: string[];
        }) => Promise<void>;
      };
    };
  }
}

interface GooglePhotosError extends Error {
  details?: {
    googleApiLoaded?: boolean;
    photosApiLoaded?: boolean;
    pickerLoaded?: boolean;
    gapiLoaded?: boolean;
    apiKey?: string;
    event?: Event | string;
    url?: string;
  };
}

export class PhotosPicker {
  private plugin: GooglePhotos;
  private editor: Editor;
  private view: MarkdownView;
  private picker: any;

  constructor(
    app: App,
    plugin: GooglePhotos,
    editor: Editor,
    view: MarkdownView
  ) {
    this.plugin = plugin;
    this.editor = editor;
    this.view = view;
  }

  async open() {
    try {
      console.log("Starting to open Google Photos picker...");
      if (!window.google?.photos?.picker) {
        console.log(
          "Google Photos API not loaded, starting loading sequence..."
        );
        // Load the Google Photos Picker API script
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://apis.google.com/js/api.js?onload=onApiLoad";

          // Define the onApiLoad function in the global scope
          (window as any).onApiLoad = () => {
            console.log("Google API loaded, loading picker...");
            window.gapi.load("picker", () => {
              console.log("Picker API loaded, checking for picker...");
              if (window.google?.photos?.picker) {
                console.log("Google Photos picker successfully loaded!");
                resolve();
              } else {
                console.error(
                  "Google Photos picker not found after initialization"
                );
                const error = new Error(
                  "Failed to load Google Photos API"
                ) as GooglePhotosError;
                error.details = {
                  googleApiLoaded: !!window.google,
                  photosApiLoaded: !!window.google?.photos,
                  pickerLoaded: !!window.google?.photos?.picker,
                  gapiLoaded: !!window.gapi,
                  apiKey: this.plugin.settings.apiKey
                    ? "API key is set"
                    : "API key is missing",
                };
                reject(error);
              }
            });
          };

          script.onerror = (event) => {
            console.error("Failed to load Google API script:", event);
            const error = new Error(
              "Failed to load Google API script"
            ) as GooglePhotosError;
            error.details = {
              event: event,
              url: script.src,
            };
            reject(error);
          };
          document.head.appendChild(script);
        });
      }

      if (!window.google?.photos?.picker) {
        console.error(
          "Google Photos picker still not available after loading sequence"
        );
        const error = new Error(
          "Google Photos API is not available"
        ) as GooglePhotosError;
        error.details = {
          googleApiLoaded: !!window.google,
          photosApiLoaded: !!window.google?.photos,
          pickerLoaded: !!window.google?.photos?.picker,
          gapiLoaded: !!window.gapi,
          apiKey: this.plugin.settings.apiKey
            ? "API key is set"
            : "API key is missing",
        };
        throw error;
      }

      console.log("Creating picker...");
      this.createPicker();
    } catch (error) {
      console.error("Error opening Google Photos picker:", error);
      // Show more detailed error message
      const googleError = error as GooglePhotosError;
      const errorMessage = googleError.details
        ? `Failed to open Google Photos picker: ${
            googleError.message
          }\nDetails: ${JSON.stringify(googleError.details, null, 2)}`
        : `Failed to open Google Photos picker: ${googleError.message}`;
      console.error("Detailed error information:", {
        error: googleError,
        details: googleError.details,
        windowState: {
          google: !!window.google,
          gapi: !!window.gapi,
          photos: !!window.google?.photos,
          picker: !!window.google?.photos?.picker,
        },
        apiKey: this.plugin.settings.apiKey
          ? "API key is set"
          : "API key is missing",
      });
      new Notice(errorMessage);
    }
  }

  private createPicker() {
    console.log(
      "Creating picker with API key:",
      this.plugin.settings.apiKey ? "API key is set" : "API key is missing"
    );
    try {
      const picker = new window.google.photos.picker.PickerBuilder()
        .addView(window.google.photos.picker.ViewId.PHOTOS)
        .setDeveloperKey(this.plugin.settings.apiKey)
        .setCallback(this.handlePickerCallback.bind(this))
        .build();
      console.log("Picker built successfully, setting visible...");
      picker.setVisible(true);
      console.log("Picker should now be visible");
      this.picker = picker;
    } catch (error) {
      console.error("Error creating picker:", error);
      throw error;
    }
  }

  private async handlePickerCallback(data: any) {
    if (data.action === "picked") {
      const selectedPhotos = data.docs;
      if (selectedPhotos && selectedPhotos.length > 0) {
        for (const photo of selectedPhotos) {
          await this.insertPhoto(photo);
        }
      }
    }
  }

  private async insertPhoto(photo: any) {
    try {
      const thumbnailSize = this.plugin.getThumbnailSize();
      const src = photo.baseUrl + `=w${thumbnailSize}-h${thumbnailSize}`;
      const noteFolder = this.view.file.path.split("/").slice(0, -1).join("/");

      // Use the note folder or the user-specified folder from Settings
      let thumbnailFolder = noteFolder;
      let linkPath = photo.filename;

      switch (this.plugin.settings.locationOption) {
        case "specified":
          thumbnailFolder = this.plugin.settings.locationFolder;
          linkPath = thumbnailFolder + "/" + photo.filename;
          break;
        case "subfolder":
          thumbnailFolder =
            noteFolder + "/" + this.plugin.settings.locationSubfolder;
          linkPath =
            this.plugin.settings.locationSubfolder + "/" + photo.filename;
          break;
      }

      thumbnailFolder = thumbnailFolder.replace(/^\/+/, "").replace(/\/+$/, "");
      linkPath = encodeURI(linkPath);

      // Create folder if it doesn't exist
      const vault = this.view.app.vault;
      if (!(await vault.adapter.exists(thumbnailFolder))) {
        await vault.createFolder(thumbnailFolder);
      }

      // Download and save the thumbnail
      const response = await fetch(src);
      const imageData = await response.arrayBuffer();
      await vault.adapter.writeBinary(
        thumbnailFolder + "/" + photo.filename,
        imageData
      );

      // Insert the markdown
      const cursorPosition = this.editor.getCursor();
      const taken_date = new Date(photo.mediaMetadata.creationTime)
        .toISOString()
        .split("T")[0];
      const taken_date_plus_one = new Date(taken_date);
      taken_date_plus_one.setDate(taken_date_plus_one.getDate() + 1);

      const linkText = this.plugin.settings.thumbnailMarkdown
        .replace("{{local_thumbnail_link}}", linkPath)
        .replace("{{google_photo_id}}", photo.id)
        .replace("{{google_photo_url}}", photo.productUrl)
        .replace("{{google_photo_desc}}", photo.description || "")
        .replace("{{google_base_url}}", photo.baseUrl)
        .replace("{{taken_date}}", taken_date)
        .replace(
          "{{taken_date_range}}",
          `${taken_date}-${taken_date_plus_one.toISOString().split("T")[0]}`
        );

      this.editor.replaceRange(linkText, cursorPosition);
      this.editor.setCursor({
        line: cursorPosition.line,
        ch: cursorPosition.ch + linkText.length,
      });
    } catch (error) {
      console.error("Error inserting photo:", error);
      new Notice("Failed to insert photo. Please try again.");
    }
  }
}
